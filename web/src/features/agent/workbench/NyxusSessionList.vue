<script setup lang="ts">
/**
 * NyxusSessionList：工作台会话列表（纯展示组件）。
 * 滚动加载（数据一次拉全、滚动容器全量渲染）+ 点击选择 + 当前高亮 + hover 放大删除（二次确认）。
 * 不依赖任何 store / nyxus 内部上下文，数据与动作全部经 props/emits 由父级注入。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import type { ChatSummary } from '@/application/backend/public'

const props = withDefaults(
  defineProps<{
    sessions: ChatSummary[]
    activeChatId?: string | null
    /** 会话目录拉取中：显示加载占位。 */
    loading?: boolean
  }>(),
  { activeChatId: null, loading: false },
)

const emit = defineEmits<{
  select: [chatId: string]
  delete: [chatId: string]
}>()

/** 滚动容器 + 行元素注册表（打开/列表刷新时定位到当前会话行）。 */
const listEl = ref<HTMLElement | null>(null)
const rowEls = new Map<string, HTMLElement>()
function bindRowEl(chatId: string, el: unknown): void {
  if (el instanceof HTMLElement) rowEls.set(chatId, el)
  else rowEls.delete(chatId)
}
/** activeChatId 或列表内容变化时滚动定位当前会话行（垂直居中）；无匹配行则不动。 */
watch(
  [() => props.activeChatId, () => props.sessions.length],
  () => {
    const id = props.activeChatId
    const container = listEl.value
    const el = id ? rowEls.get(id) : undefined
    if (!id || !el || !container) return
    container.scrollTop = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
  },
  { immediate: true, flush: 'post' },
)

/** 每行删除二次确认：点删除原位变「确认？」红字 2s，再点才 emit('delete')。 */
const confirmId = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | undefined

function onDeleteRequest(chatId: string): void {
  if (confirmId.value === chatId) return
  confirmId.value = chatId
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => {
    confirmId.value = null
    confirmTimer = undefined
  }, 2000)
}

function onDeleteConfirm(chatId: string): void {
  if (confirmId.value !== chatId) return
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = undefined
  }
  confirmId.value = null
  emit('delete', chatId)
}

onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
})

/** 末次时间：当天 HH:mm，否则 M/d（复用旧钢琴 formatTime 规则）。 */
function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()}`
}

/** 行标题：preview（首条 user 消息）缺省显示「无消息」；title 携带完整信息。 */
function previewOf(s: ChatSummary): string {
  return s.preview?.trim() || '无消息'
}
</script>

<template>
  <div class="session-list">
    <div v-if="loading" class="session-list-loading" aria-live="polite">会话加载中…</div>
    <template v-else>
      <ul v-if="sessions.length" ref="listEl" class="session-list-rows">
        <li
          v-for="(s, index) in sessions"
          :key="s.chatId"
          :ref="(el) => bindRowEl(s.chatId, el)"
          class="session-row"
          :class="{ 'is-active': s.chatId === activeChatId }"
          @click="emit('select', s.chatId)"
        >
          <span class="session-row-index" aria-hidden="true">{{ index + 1 }}</span>
          <span class="session-row-body">
            <span class="session-row-preview" :title="previewOf(s)">{{ previewOf(s) }}</span>
            <span class="session-row-meta">
              <span class="session-row-time">{{ formatTime(s.updatedAt ?? s.createdAt) }}</span>
              <span v-if="s.turnCount != null" class="session-row-turns">{{ s.turnCount }} 轮</span>
            </span>
          </span>
          <button
            type="button"
            class="session-row-del"
            :class="{ 'is-confirming': confirmId === s.chatId }"
            :disabled="s.running === true"
            :aria-label="confirmId === s.chatId ? '确认删除该会话' : '删除该会话'"
            :title="
              s.running
                ? '运行中的会话不可删除'
                : confirmId === s.chatId
                  ? '再次点击确认删除'
                  : '删除该会话'
            "
            @click.stop="
              confirmId === s.chatId ? onDeleteConfirm(s.chatId) : onDeleteRequest(s.chatId)
            "
          >
            {{ confirmId === s.chatId ? '确认？' : '✕' }}
          </button>
        </li>
      </ul>
      <div v-else class="session-list-empty">该预设暂无会话，可用右侧新建会话按钮</div>
    </template>
  </div>
</template>

<style scoped lang="less">
// 全直角 + 字重 400（标题/强调 ≤600）。
// 颜色走主题 token（--ink/--accent/--border/--danger + color-mix），
// 浅深双端自适应，统一主题色调（ui-visual-and-interaction.md §4）。
.session-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 340px;
}
.session-list-rows {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 340px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.session-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
  box-sizing: border-box;
  border-radius: 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  &:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  &.is-active {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    .session-row-preview {
      color: var(--accent-ink);
    }
  }
}
.session-row-index {
  flex: 0 0 auto;
  width: 18px;
  text-align: right;
  font:
    400 10px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  color: color-mix(in srgb, var(--ink) 40%, transparent);
}
.session-row-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.session-row-preview {
  overflow: hidden;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  font-weight: 400;
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font:
    400 10px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
}
.session-row-del {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 0;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--ink) 45%, transparent);
  border-radius: 0;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 120ms ease,
    color 120ms ease,
    border-color 120ms ease,
    background 120ms ease;
  .session-row:hover & {
    opacity: 1;
  }
  &:hover:not(:disabled) {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 70%, transparent);
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }
  &.is-confirming {
    width: auto;
    padding: 0 8px;
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 70%, transparent);
    background: color-mix(in srgb, var(--danger) 16%, transparent);
    font-size: 11px;
    font-weight: 600;
    opacity: 1;
    &:hover {
      color: color-mix(in srgb, var(--danger) 70%, var(--ink));
    }
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }
}
.session-list-loading,
.session-list-empty {
  flex: 1 1 auto;
  min-height: 80px;
  display: grid;
  place-items: center;
  color: color-mix(in srgb, var(--ink) 50%, transparent);
  font-weight: 400;
  font-size: 12px;
}
</style>
