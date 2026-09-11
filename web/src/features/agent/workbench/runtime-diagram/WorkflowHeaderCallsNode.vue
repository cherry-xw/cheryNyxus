<script setup lang="ts">
import type { NodeProps } from '@vue-flow/core'
import type { HeaderChildData, HeaderScopeEvent } from './headerGraph'
import { headerStatusText, type HeaderSlotStatus } from './headerState'
defineProps<NodeProps<Extract<HeaderChildData, { kind: 'header-calls' }>>>()
const emit = defineEmits<{ selectScope: [event: HeaderScopeEvent] }>()
</script>
<template>
  <section
    class="workflow-calls nodrag nopan nowheel"
    aria-label="共享处理链的调用选择"
    @pointerdown.stop
    @wheel.stop
  >
    <header>
      <span>{{ data.state.followingCurrent ? '跟随执行调用' : '正在查看历史调用' }}</span>
      <button
        v-if="!data.state.followingCurrent"
        type="button"
        @click.stop="
          emit('selectScope', {
            headerId: data.headerId,
            scope: { ...data.state.selection, callId: undefined },
          })
        "
      >
        返回当前调用
      </button>
    </header>
    <ol v-if="data.state.calls.length" aria-label="本次尝试全部工具调用">
      <li v-for="call in data.state.calls" :key="call.id">
        <button
          type="button"
          :aria-pressed="call.id === data.state.selectedCallId"
          :title="call.name"
          @click.stop="
            emit('selectScope', {
              headerId: data.headerId,
              scope: { ...data.state.selection, callId: call.id },
            })
          "
        >
          <span>调用 {{ call.ordinal }} · {{ call.name }}</span>
          <small
            >{{ call.current ? '当前执行 · ' : ''
            }}{{ headerStatusText(call.status as HeaderSlotStatus) }}</small
          >
        </button>
      </li>
    </ol>
    <p v-else>当前范围尚无工具调用</p>
  </section>
</template>
<style scoped lang="less">
.workflow-calls {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--border);
  padding: 8px;
  font-size: 12px;
  font-weight: 400;
}
header {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-height: 32px;
  padding-bottom: 6px;
}
ol {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
  scrollbar-color: var(--border-strong) var(--panel);
}
button {
  box-sizing: border-box;
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 4px 8px;
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  font-weight: 400;
  cursor: pointer;
}
li button {
  display: grid;
  gap: 4px;
  width: 100%;
  min-height: 50px;
  border-color: transparent;
  border-bottom-color: var(--border);
  text-align: left;
}
li span,
li small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 400;
}
button:hover,
button[aria-pressed='true'] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
p {
  margin: 16px 0;
}
</style>
