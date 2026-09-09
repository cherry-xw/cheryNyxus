<script setup lang="ts">
import { computed, ref, toRef, useId } from 'vue'
import {
  VideoPlay,
  VideoPause,
  ArrowLeft,
  ArrowRight,
  Aim,
  Check,
  Loading,
  Warning,
  Minus,
  Document,
  Connection,
  Refresh,
  Tools,
  Download,
  Switch,
  Flag,
  FolderOpened,
} from '@element-plus/icons-vue'
import type { WorkflowNodeId, WorkflowCall } from '@chery/protocol'
import { workflowNodes } from './model'
import { useWorkflowController } from './useWorkflowController'

const props = withDefaults(
  defineProps<{ chatId: string; vertical?: boolean; suspended?: boolean }>(),
  { vertical: false, suspended: false },
)
const {
  snapshot,
  loading,
  historyLoading,
  error,
  historyError,
  synced,
  replay,
  playing,
  speed,
  cursor,
  frames,
  history,
  play,
  seek,
  open,
  loadHistory,
  returnLive,
} = useWorkflowController(toRef(props, 'chatId'), toRef(props, 'suspended'))
const markerId = useId().replace(/:/g, '')
const callsRef = ref<HTMLElement>()
const icons = {
  context: Document,
  input: Download,
  model: Connection,
  tools: Tools,
  checkpoint: FolderOpened,
  decision: Switch,
  result: Flag,
  command: Document,
  retry: Refresh,
  compact: FolderOpened,
}
const statusLabels = {
  idle: '未运行',
  running: '运行中',
  paused: '已暂停',
  completed: '本轮完成',
  failed: '本轮失败',
  cancelled: '已取消',
  unknown: '状态未知',
}
const callLabels: Record<WorkflowCall['status'], string> = {
  pending: '待执行',
  running: '执行中',
  waiting: '等待确认',
  completed: '已完成',
  failed: '失败',
  rejected: '已拒绝',
  cancelled: '已取消',
  unknown: '结果未知',
}
const waitLabels = {
  model: '等待模型',
  approval: '等待审批',
  answer: '等待回答',
  child: '等待子返回',
  retry: '等待重试',
}
const statusText = computed(() => {
  const data = snapshot.value
  if (!data) return loading.value ? '加载中' : '未同步'
  return `${statusLabels[data.status]}${data.waitReason ? ` · ${waitLabels[data.waitReason]}` : ''}`
})
const positions = computed(
  () =>
    Object.fromEntries(
      workflowNodes.map((node, index) => {
        if (!props.vertical)
          return [
            node.id,
            {
              x:
                index < 7
                  ? 12 + index * 152
                  : { command: 164, retry: 316, compact: 772 }[
                      node.id as 'command' | 'retry' | 'compact'
                    ],
              y: index < 7 ? 24 : 120,
            },
          ]
        const y =
          index < 7
            ? 24 + index * 84 + (index > 3 ? 236 : 0)
            : { command: 868, retry: 952, compact: 1036 }[
                node.id as 'command' | 'retry' | 'compact'
              ]
        return [node.id, { x: 20, y }]
      }),
    ) as Record<WorkflowNodeId, { x: number; y: number }>,
)
const nodeWidth = computed(() => (props.vertical ? 248 : 136))
const paths = computed(() => {
  const pairs: Array<[WorkflowNodeId, WorkflowNodeId, boolean]> = [
    ['context', 'input', false],
    ['input', 'model', false],
    ['model', 'tools', false],
    ['tools', 'checkpoint', false],
    ['checkpoint', 'decision', false],
    ['decision', 'result', false],
    ['model', 'checkpoint', true],
    ['decision', 'input', true],
    ['command', 'input', true],
    ['model', 'retry', true],
    ['retry', 'model', true],
    ['decision', 'compact', true],
    ['compact', 'result', true],
    ['input', 'tools', true],
  ]
  return pairs.map(([from, to, conditional]) => {
    const a = positions.value[from],
      b = positions.value[to]
    const d = props.vertical
      ? conditional
        ? `M${a.x + nodeWidth.value} ${a.y + 28} H286 V${b.y + 28} H${b.x + nodeWidth.value}`
        : `M${a.x + 124} ${a.y + 56} V${b.y}`
      : conditional
        ? `M${a.x + 68} ${a.y} V8 H${b.x + 68} V${b.y}`
        : `M${a.x + nodeWidth.value} ${a.y + 28} H${b.x}`
    return { id: `${from}-${to}`, d, conditional }
  })
})
function nodeState(id: WorkflowNodeId) {
  if (snapshot.value?.activeNodeId === id)
    return snapshot.value.status === 'running' ? 'running' : snapshot.value.status
  return snapshot.value?.visitedNodeIds.includes(id) ? 'completed' : 'idle'
}
function nodeLabel(id: WorkflowNodeId) {
  if (snapshot.value?.activeNodeId === id) return snapshot.value.phaseLabel || statusText.value
  if (id === 'compact' && snapshot.value?.compactRequested) return '已请求 · 尚未生效'
  return snapshot.value?.visitedNodeIds.includes(id) ? '已经过' : '未参与'
}
function locateCurrent() {
  const list = callsRef.value
  const current = list?.querySelector<HTMLElement>('[data-current="true"]')
  if (list && current)
    list.scrollTop += current.getBoundingClientRect().top - list.getBoundingClientRect().top
}
const completedCalls = computed(
  () =>
    snapshot.value?.batch?.calls.filter((call) =>
      ['completed', 'failed', 'rejected', 'cancelled'].includes(call.status),
    ).length ?? 0,
)
const visibleNodes = computed(() =>
  workflowNodes.filter(
    (node) =>
      !node.conditional ||
      (node.id === 'compact' && snapshot.value?.compactRequested) ||
      snapshot.value?.activeNodeId === node.id ||
      snapshot.value?.visitedNodeIds.includes(node.id),
  ),
)
const visiblePaths = computed(() =>
  paths.value.filter((path) => {
    const [from, to] = path.id.split('-')
    return (
      visibleNodes.value.some((node) => node.id === from) &&
      visibleNodes.value.some((node) => node.id === to)
    )
  }),
)
</script>

<template>
  <section
    class="runtime-diagram"
    :class="{ 'is-vertical': vertical, 'is-suspended': suspended || (!synced && !replay) }"
    aria-label="主 Agent 运行流程"
    :aria-busy="loading || historyLoading"
  >
    <header class="workflow-toolbar">
      <h3>主 Agent 流程</h3>
      <span class="workflow-overall" role="status">{{ statusText }}</span>
      <div class="workflow-mode" role="group" aria-label="流程显示模式">
        <button type="button" :aria-pressed="!replay" @click="returnLive">实时</button>
        <button type="button" :aria-pressed="replay" @click="loadHistory()">回放</button>
      </div>
      <el-tooltip
        content="仅观察主 Agent。流程节点显示基础阶段；完整内容在消息节点树查看。前/后 Hook 表示挂载位置，不表示实际执行。"
        placement="bottom"
      >
        <button type="button" aria-label="运行流程说明">说明</button>
      </el-tooltip>
    </header>
    <div v-if="replay" class="workflow-playback" role="group" aria-label="回放控制">
      <select
        :value="history?.contextStageId"
        aria-label="上下文阶段"
        :disabled="historyLoading || !history"
        @change="loadHistory(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="stage in history?.stages" :key="stage.id" :value="stage.id">
          {{ stage.label }}{{ stage.quality === 'reconstructed' ? '（重建）' : '' }}
        </option>
      </select>
      <button
        type="button"
        aria-label="上一步"
        title="上一步"
        :disabled="!frames.length || cursor === 0"
        @click="seek(cursor - 1)"
      >
        <ArrowLeft />
      </button>
      <button
        type="button"
        :aria-label="playing ? '暂停回放' : '播放回放'"
        :title="!frames.length ? '加载完整历史后可播放' : playing ? '暂停回放' : '播放回放'"
        :disabled="!frames.length || historyLoading"
        @click="play"
      >
        <VideoPause v-if="playing" /><VideoPlay v-else />
      </button>
      <button
        type="button"
        aria-label="下一步"
        title="下一步"
        :disabled="!frames.length || cursor >= frames.length - 1"
        @click="seek(cursor + 1)"
      >
        <ArrowRight />
      </button>
      <input
        type="range"
        aria-label="回放进度"
        :min="0"
        :max="Math.max(0, frames.length - 1)"
        :value="cursor"
        :disabled="!frames.length"
        @input="seek(Number(($event.target as HTMLInputElement).value))"
      />
      <span>{{ frames.length ? cursor + 1 : 0 }}/{{ frames.length }}</span>
      <select v-model.number="speed" aria-label="回放速度">
        <option v-for="value in [0.5, 1, 2, 4]" :key="value" :value="value">{{ value }}x</option>
      </select>
    </div>
    <div class="workflow-information">
      <span title="中间件从外到内的包裹关系">Loop [Checkpoint [Sense [Retry [Chat]]]]</span>
      <span title="生效提示词中的记忆索引数"
        >记忆（{{ snapshot?.resources.memoryCount ?? '未知' }}）</span
      >
      <span title="生效提示词中可发现的技能数"
        >技能（{{ snapshot?.resources.skillCount ?? '未知' }}）</span
      >
      <span title="当前有效上下文中已确认加载正文的去重技能数"
        >已加载 {{ snapshot?.resources.loadedSkillCount ?? '未知'
        }}{{ snapshot?.resources.loadedSkillsComplete ? '' : '（不完整）' }}</span
      >
    </div>
    <div v-if="replay ? historyError : error" class="workflow-notice" role="alert">
      {{ replay ? historyError : error }}
      <button type="button" @click="replay ? loadHistory() : open()">重试</button>
    </div>
    <div v-else-if="loading || historyLoading" class="workflow-notice" role="status">
      {{ historyLoading ? '正在加载完整历史…' : '正在同步运行状态…' }}
    </div>
    <div v-else-if="!synced && !replay" class="workflow-notice" role="status">
      连接不可用 · 当前显示最后已知状态，尚未同步
    </div>
    <div
      v-else-if="
        replay &&
        history &&
        (!history.historyComplete ||
          history.facts.some((fact) => fact.orderQuality === 'reconstructed'))
      "
      class="workflow-notice"
    >
      部分步骤不可还原；旧批次按稳定顺序播放，不代表精确执行时序。
    </div>
    <div v-else-if="replay && history && !frames.length" class="workflow-notice">
      此阶段暂无可回放结果。
    </div>
    <div v-else-if="snapshot?.status === 'running' && !snapshot.phaseKnown" class="workflow-notice">
      运行中 · 当前细分阶段未知，等待下一个真实边界。
    </div>
    <div
      class="workflow-viewport"
      tabindex="0"
      aria-label="流程图，可独立滚动"
      @wheel.stop
      @pointerdown.stop
    >
      <div
        class="workflow-canvas"
        :style="{ width: vertical ? '296px' : '1072px', height: vertical ? '1120px' : '312px' }"
      >
        <svg
          class="workflow-lines"
          :viewBox="vertical ? '0 0 296 1120' : '0 0 1072 312'"
          aria-hidden="true"
        >
          <defs>
            <marker
              :id="markerId"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L6 3 L0 6" fill="none" stroke="currentColor" />
            </marker>
          </defs>
          <path
            v-for="path in visiblePaths"
            :key="path.id"
            :d="path.d"
            :class="{ 'is-conditional': path.conditional }"
            :marker-end="`url(#${markerId})`"
          />
        </svg>
        <div
          v-for="node in visibleNodes"
          :key="node.id"
          class="workflow-node"
          :class="[`state-${nodeState(node.id)}`, { 'is-conditional': node.conditional }]"
          :style="{
            left: `${positions[node.id].x}px`,
            top: `${positions[node.id].y}px`,
            width: `${nodeWidth}px`,
          }"
          :title="node.description"
          :aria-current="snapshot?.activeNodeId === node.id ? 'step' : undefined"
        >
          <span class="workflow-node-title"
            ><component :is="icons[node.id]" aria-hidden="true" />{{ node.label }}</span
          >
          <span class="workflow-node-status"
            ><Loading
              v-if="nodeState(node.id) === 'running'"
              class="workflow-active-icon"
              aria-hidden="true"
            /><Check v-else-if="nodeState(node.id) === 'completed'" aria-hidden="true" /><Warning
              v-else-if="nodeState(node.id) === 'failed'"
              aria-hidden="true"
            /><Minus v-else aria-hidden="true" /><span>{{ nodeLabel(node.id) }}</span></span
          >
          <span v-if="node.id === 'model'" class="workflow-hooks"
            ><span>{{ snapshot?.modelHooks?.before ? '前 Hook' : '' }}</span
            ><span>{{ snapshot?.modelHooks?.after ? '后 Hook' : '' }}</span></span
          >
        </div>
        <div
          class="workflow-calls"
          :style="{
            left: `${positions.tools.x}px`,
            top: `${positions.tools.y + 62}px`,
            width: vertical ? '248px' : '240px',
          }"
        >
          <template v-if="snapshot?.batch?.calls.length">
            <div class="workflow-calls-head">
              <span>调用 {{ snapshot.batch.calls.length }} · 已结束 {{ completedCalls }}</span
              ><button
                type="button"
                aria-label="定位当前调用"
                title="定位当前调用"
                @click="locateCurrent"
              >
                <Aim />
              </button>
            </div>
            <ol ref="callsRef" aria-label="当前工具批次" tabindex="0">
              <li
                v-for="(call, index) in snapshot.batch.calls"
                :key="call.id"
                :data-current="call.status === 'running' || call.status === 'waiting'"
                :class="`call-${call.status}`"
                :title="`${call.name} · ${callLabels[call.status]}${call.summary ? ` · ${call.summary}` : ''}`"
              >
                <span>{{ index + 1 }}</span
                ><span class="workflow-call-name">{{ call.name }}</span
                ><span>{{ callLabels[call.status] }}</span
                ><span
                  v-if="call.beforeHook || call.afterHook"
                  :title="`${call.beforeHook ? '前 Hook' : ''} ${call.afterHook ? '后 Hook' : ''}`"
                  >{{ call.beforeHook ? '前' : '' }}{{ call.afterHook ? '后' : '' }} Hook</span
                >
              </li>
            </ol>
          </template>
          <ul
            v-if="snapshot?.dispatches.length"
            class="workflow-dispatches"
            aria-label="子任务派发与回传"
          >
            <li v-for="dispatch in snapshot.dispatches" :key="dispatch.id">
              {{ dispatch.name }} ·
              {{
                {
                  waiting: '已派发 · 等待返回',
                  returned: '已返回',
                  failed: '失败',
                  cancelled: '已取消',
                }[dispatch.status]
              }}
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less" src="./RuntimeDiagram.styles.less"></style>
