<script setup lang="ts">
/**
 * TodoPanel：pet 右侧 todo 侧栏（能力驱动）。
 * 显示条件（父 PetSprite 门控）：pet 的 senseGroups（经 sense.list 解析）含 update_todo 且有内容。
 * 数据：streams[pet.chatId].history walk back 最近一次 update_todo senseCall 的 args.todos。
 * 只读 checklist（pending ☐ / in_progress ▣ / completed ✓+strikethrough）。无聚合（每 pet 显自己 todo）。
 * 支持实时显示：当 runningTools 中有 update_todo 时，显示"执行中"占位符。
 */
import { computed } from 'vue'
import type { PetInstance } from '@/features/pets/types/types'
import { useChatSessionsStore } from '@/stores'
import type { SenseCallRecord } from '@/stores/agents'
import type { TodoItem } from '../renderers/types'
import { selectOwnTimeline } from '@/stores/chats/selectors'

const props = defineProps<{ pet: PetInstance }>()
const chatSessions = useChatSessionsStore()

/** walk back history 找最近一次 update_todo 调用的 todos（取最新 item 内最新一次）。 */
const todos = computed<TodoItem[]>(() => {
  const session = chatSessions.sessionsById[props.pet.chatId]
  if (!session) return []
  if (Array.isArray(session.interaction.currentTodo)) {
    return session.interaction.currentTodo as TodoItem[]
  }
  const history = selectOwnTimeline(session)
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const calls = history[i]?.senseCalls
    if (!calls || calls.length === 0) continue
    for (let j = calls.length - 1; j >= 0; j -= 1) {
      const c: SenseCallRecord | undefined = calls[j]
      if (!c) continue
      if (c.name !== 'update_todo') continue
      try {
        const raw = typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {})
        const obj = JSON.parse(raw) as { todos?: TodoItem[] }
        if (Array.isArray(obj.todos)) return obj.todos
      } catch {
        /* 继续向前找 */
      }
    }
  }
  return []
})

/** 检查 runningTools 中是否有 update_todo（实时执行中） */
const isRunning = computed(() => {
  return (chatSessions.sessionsById[props.pet.chatId]?.interaction.runningTools ?? []).some(
    (tool) => tool.name === 'update_todo',
  )
})

const doneCount = computed(() => todos.value.filter((t) => t.status === 'completed').length)
const statusGlyph = (s: TodoItem['status']): string =>
  s === 'completed' ? '✓' : s === 'in_progress' ? '▣' : '☐'
</script>

<template>
  <div class="todo-panel" aria-label="待办列表">
    <div class="panel-head">
      <span class="head-icon" aria-hidden="true">📋</span>
      <span class="head-title">待办</span>
      <span v-if="todos.length" class="head-count">{{ doneCount }}/{{ todos.length }}</span>
    </div>
    <ul v-if="todos.length" class="panel-list">
      <li v-for="(t, i) in todos" :key="i" class="panel-item" :class="`is-${t.status}`">
        <span class="glyph" aria-hidden="true">{{ statusGlyph(t.status) }}</span>
        <span class="content">
          <span class="text" :class="{ done: t.status === 'completed' }">{{ t.content }}</span>
        </span>
      </li>
    </ul>
    <div v-else-if="isRunning" class="panel-loading">
      <span class="loading-icon" aria-hidden="true">⏳</span>
      <span class="loading-text">加载待办…</span>
    </div>
    <span v-else class="empty">暂无待办</span>
  </div>
</template>

<style scoped lang="less">
@import '@/styles/scrollbar.less';
@ink: var(--ink);
@glyph-fonts: ui-rounded, 'Hiragino Sans', 'PingFang SC', 'Noto Sans Symbols 2',
  'Noto Sans Symbols', 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif;

.todo-panel {
  min-width: 96px;
  max-width: 168px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-soft);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.16);
  color: var(--ink);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.3;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  padding-bottom: 3px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);

  .head-icon {
    font-family: @glyph-fonts;
    font-size: 10px;
  }
  .head-title {
    flex: 1;
    font-weight: 600;
  }
  .head-count {
    font-size: 9px;
    font-weight: 700;
    color: color-mix(in srgb, var(--ink) 56%, transparent);
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  }
}

.panel-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 140px;
  overflow: auto;
  .inner-scrollbar(); /* 内层滚动：todo 列表，弱化滚动条 */
}

.panel-item {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;

  .glyph {
    flex-shrink: 0;
    font-family: @glyph-fonts;
    font-size: 10px;
    line-height: 1.4;
  }
  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .text {
    white-space: pre-wrap;
    word-break: break-word;

    &.done {
      text-decoration: line-through;
      color: color-mix(in srgb, var(--ink) 44%, transparent);
    }
  }

  &.is-in_progress .glyph {
    color: #eab308;
    animation: tp-pulse 1.1s ease-in-out infinite;
  }
  &.is-completed .glyph {
    color: #16a34a;
  }
}

.empty {
  font-size: 9.5px;
  font-style: italic;
  color: color-mix(in srgb, var(--ink) 44%, transparent);
}

.panel-loading {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;

  .loading-icon {
    font-family: @glyph-fonts;
    font-size: 10px;
    animation: tp-spin 1.5s linear infinite;
  }

  .loading-text {
    font-size: 9.5px;
    font-style: italic;
    color: color-mix(in srgb, var(--ink) 56%, transparent);
  }
}

@keyframes tp-spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

@keyframes tp-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
