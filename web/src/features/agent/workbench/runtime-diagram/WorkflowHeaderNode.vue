<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import type { WorkflowGraphNodeData } from './graphModel'
import type { HeaderScopeEvent, HeaderGroupToggleEvent } from './headerGraph'
import { headerStatusText } from './headerState'

type HeaderData = Extract<WorkflowGraphNodeData, { kind: 'header' }>
const props = defineProps<NodeProps<HeaderData>>()
const emit = defineEmits<{
  selectScope: [event: HeaderScopeEvent]
  resetGroupOverrides: [headerId: string]
  toggle: [event: HeaderGroupToggleEvent]
}>()
const runStatusText = computed(
  () =>
    ({
      running: '运行中',
      waiting: '等待中',
      paused: '已暂停',
      completed: '等待用户输入',
      failed: '失败',
      cancelled: '已取消',
      idle: '等待用户输入',
    })[props.data.runStatus] ?? '状态未知',
)
const current = computed(() => props.data.active.at(-1) ?? props.data.state.occurrences.at(-1))
function selectScope(key: 'runId' | 'iteration' | 'attempt', event: Event) {
  const value = (event.target as HTMLSelectElement).value
  const scope =
    key === 'runId'
      ? { runId: value || undefined, unassignedRun: !value }
      : key === 'iteration'
        ? {
            runId: props.data.state.scope.runId,
            unassignedRun: props.data.state.scope.unassignedRun,
            iteration: Number(value),
          }
        : { ...props.data.state.scope, attempt: Number(value), callId: undefined }
  emit('selectScope', { headerId: props.id, scope })
}
</script>

<template>
  <section
    class="workflow-header-shell"
    :class="`is-${data.mode}`"
    :aria-label="`${data.title}，${runStatusText}`"
    :data-template-version="data.templateVersion"
    :data-workflow-header-id="id"
  >
    <Handle
      id="header-in"
      type="target"
      :position="Position.Left"
      :style="data.mode === 'full' ? { top: '188px' } : {}"
    />
    <button
      v-if="data.collapsed"
      type="button"
      class="workflow-collapsed-title nodrag nopan"
      aria-expanded="false"
      :aria-label="`展开${data.title}`"
      @pointerdown.stop
      @click.stop="emit('toggle', { headerId: id, groupId: 'header' })"
    >
      {{ data.title }}
    </button>
    <header v-else class="workflow-header-caption">
      <strong>{{ data.title }}</strong>
      <span v-if="data.mode === 'full' && data.iterationCount > 0" class="workflow-header-iteration"
        >第 {{ data.currentIteration }} 轮</span
      >
      <span>{{ runStatusText }}</span>
      <template v-if="data.mode === 'full'">
        <label
          v-if="data.state.runs.length || data.state.hasUnassignedRun"
          class="nodrag nopan nowheel"
          >运行
          <select
            :value="data.state.scope.runId ?? ''"
            @change="selectScope('runId', $event)"
            @pointerdown.stop
            @wheel.stop
          >
            <option v-if="data.state.hasUnassignedRun" value="">未归属运行的记录</option>
            <option v-for="(run, index) in data.state.runs" :key="run" :value="run">
              第 {{ index + 1 }} 次运行
            </option>
          </select>
        </label>
        <label v-if="data.state.iterations.length" class="nodrag nopan nowheel"
          >轮次
          <select
            :value="data.state.scope.iteration"
            @change="selectScope('iteration', $event)"
            @pointerdown.stop
            @wheel.stop
          >
            <option v-for="iteration in data.state.iterations" :key="iteration" :value="iteration">
              {{ iteration }}
            </option>
          </select>
        </label>
        <label v-if="data.state.attempts.length" class="nodrag nopan nowheel"
          >尝试
          <select
            :value="data.state.scope.attempt"
            @change="selectScope('attempt', $event)"
            @pointerdown.stop
            @wheel.stop
          >
            <option v-for="attempt in data.state.attempts" :key="attempt" :value="attempt">
              {{ attempt }}
            </option>
          </select>
        </label>
        <button
          type="button"
          class="nodrag nopan"
          @pointerdown.stop
          @click.stop="emit('selectScope', { headerId: id, scope: {} })"
        >
          查看当前运行
        </button>
        <button
          type="button"
          class="nodrag nopan"
          @pointerdown.stop
          @click.stop="emit('resetGroupOverrides', id)"
        >
          定位当前步骤
        </button>
        <button
          type="button"
          class="nodrag nopan"
          @pointerdown.stop
          @click.stop="emit('toggle', { headerId: id, groupId: 'header' })"
        >
          收起头部
        </button>
      </template>
    </header>
    <div
      v-if="data.mode === 'compact' && !data.collapsed"
      class="workflow-header-summary"
      data-workflow-highlight-target
    >
      <span>{{ current?.label ?? '等待新的执行步骤' }}</span>
      <small>{{
        current ? headerStatusText(current.status, current.waitReason) : data.state.coverage
      }}</small>
    </div>

  </section>
</template>

<style scoped lang="less">
.workflow-header-shell {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: 1px solid var(--border-strong);
  background: color-mix(in srgb, var(--panel) 86%, transparent);
  color: var(--ink);
}
.workflow-header-shell.is-compact {
  background: var(--surface);
}
.workflow-collapsed-title {
  width: 100%;
  height: 100%;
  padding: 12px;
  background: transparent;
  color: var(--ink);
  border: 0;
  border-radius: 0;
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-collapsed-title:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.workflow-header-caption {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 64px;
  flex-wrap: wrap;
  align-content: center;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.workflow-header-caption strong {
  font-size: 18px;
  font-weight: 600;
}
.workflow-header-caption span,
.workflow-header-caption label,
.workflow-header-caption button,
.workflow-header-caption select {
  font-size: 14px;
  font-weight: 400;
}
.workflow-header-iteration {
  display: inline-flex;
  align-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 46%, var(--border));
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
  color: var(--accent);
  padding: 2px 8px;
  font-size: 14px;
  font-weight: 400;
  white-space: nowrap;
}
.workflow-header-caption label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.workflow-header-caption select,
.workflow-header-caption button {
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface);
  color: var(--ink);
  padding: 4px 8px;
}
.workflow-header-caption button {
  cursor: pointer;
}
.workflow-header-caption button:hover {
  border-color: var(--accent);
}
.workflow-header-caption :is(button, select):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.is-compact .workflow-header-caption {
  display: grid;
  align-content: center;
  gap: 4px;
  height: 40px;
  min-height: 40px;
  padding: 0 12px;
}
.is-compact .workflow-header-caption strong {
  font-size: 15px;
}
.workflow-header-summary {
  display: grid;
  gap: 4px;
  padding: 4px 12px;
}
.workflow-header-summary span,
.workflow-header-summary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 400;
}
</style>
