<script setup lang="ts">
/**
 * SessionDropdown：标题栏会话下拉（当前预设 + 分页）。
 * 打开时拉首页（chat.list scope=preset 分页，SESSION_PAGE_SIZE/页），滚动到底或「加载更多」追加；
 * 默认第一项（最近更新）高亮；点击行切换会话；行 hover 提供归档（删除）按钮——删除当前会话后
 * 选最新剩余（删除前捕获意图，请求返回且用户未中途切换时才切，防竞态，契约同旧 rail popout）；
 * 空态提供「新建会话」。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ChatSummary } from '@/application/backend/public'
import { useAgentsStore } from '@/application/public'
import { useSessionDropdown } from './useSessionDropdown'

const props = withDefaults(
  defineProps<{
    windowId: string
    presetId?: string
    presetName?: string
    activeChatId?: string | null
  }>(),
  { presetId: undefined, presetName: undefined, activeChatId: null },
)

const emit = defineEmits<{
  select: [chatId: string]
  create: []
  close: []
  /** 当前会话被归档且无剩余会话可切：父级清空窗口当前会话。 */
  clear: []
}>()

const agents = useAgentsStore()

const { items, total, loading, loadingMore, error, hasMore, open, loadMore } = useSessionDropdown({
  presetId: props.presetId,
  presetName: props.presetName,
})
const listEl = ref<HTMLElement | null>(null)

onMounted(() => {
  void open()
})

/** 默认第一个：当前会话不在列表时高亮第一项（最近更新）。 */
const defaultFirst = computed(() => (props.activeChatId ? undefined : items.value[0]?.chatId))

/** 末次时间：当天 HH:mm，否则 M/d（复用会话列表 formatTime 规则）。 */
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

function previewOf(s: ChatSummary): string {
  return s.preview?.trim() || '无消息'
}

function isActive(s: ChatSummary): boolean {
  return s.chatId === props.activeChatId || s.chatId === defaultFirst.value
}

function onScroll(e: Event): void {
  const el = e.currentTarget as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) void loadMore()
}

function onRetry(): void {
  void open()
}

function onSelect(s: ChatSummary): void {
  emit('select', s.chatId)
  emit('close')
}

/** 归档会话：删除前捕获当前会话意图，请求返回后仅当用户未中途切换时才切到最新剩余（防竞态覆盖）。 */
async function onArchive(s: ChatSummary): Promise<void> {
  const deletingActive = s.chatId === props.activeChatId
  try {
    await agents.deleteSession(s.chatId)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '归档会话失败')
    return
  }
  items.value = items.value.filter((chat) => chat.chatId !== s.chatId)
  total.value = Math.max(0, total.value - 1)
  // 当前会话被归档 → 选最新剩余（仅当用户未在请求期间切换）。
  if (deletingActive && props.activeChatId) {
    const latest = items.value[0]
    if (latest) emit('select', latest.chatId)
    else emit('clear')
  }
  ElMessage.success('会话已归档，可在设置 → 归档中查看')
  emit('close')
}

/** 会话行滚动定位：打开/切换时让当前会话行可见。 */
watch(
  () => [props.activeChatId, items.value.length],
  () => {
    const el = listEl.value
    const active = items.value.find(isActive)
    if (!el || !active) return
    const row = el.querySelector<HTMLElement>(`[data-chat-id="${active.chatId}"]`)
    if (row) row.scrollIntoView({ block: 'nearest' })
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="session-dropdown" role="dialog" aria-label="会话列表">
    <header class="dropdown-head">
      <span class="dropdown-title">会话</span>
      <button type="button" class="dropdown-close" aria-label="关闭会话列表" @click="emit('close')">
        ✕
      </button>
    </header>
    <div v-if="loading" class="dropdown-state">会话加载中…</div>
    <div v-else-if="error" class="dropdown-state">
      <span>{{ error }}</span>
      <button type="button" class="dropdown-retry" @click="onRetry">重试</button>
    </div>
    <ul v-else-if="items.length" ref="listEl" class="dropdown-list" @scroll="onScroll">
      <li
        v-for="s in items"
        :key="s.chatId"
        class="dropdown-row"
        :class="{ 'is-active': isActive(s) }"
      >
        <button
          type="button"
          class="dropdown-row-select"
          :data-chat-id="s.chatId"
          :aria-current="isActive(s) ? 'true' : undefined"
          @click="onSelect(s)"
        >
          <span class="dropdown-row-preview" :title="previewOf(s)">{{ previewOf(s) }}</span>
          <span class="dropdown-row-meta">
            <span v-if="s.running" class="dropdown-row-running" aria-label="运行中">▶</span>
            <span>{{ formatTime(s.updatedAt ?? s.createdAt) }}</span>
            <span v-if="s.turnCount != null">{{ s.turnCount }} 轮</span>
            <span v-if="s.pendingApproval" class="dropdown-row-pending">待审批</span>
            <span v-else-if="s.pendingQuestionCount" class="dropdown-row-pending">待回答</span>
          </span>
        </button>
        <button
          type="button"
          class="dropdown-row-archive"
          :aria-label="`归档会话：${previewOf(s)}`"
          :title="'归档到设置 → 归档'"
          @click.stop="() => void onArchive(s)"
        >
          🗑
        </button>
      </li>
    </ul>
    <div v-else class="dropdown-state">该预设暂无会话</div>
    <footer class="dropdown-foot">
      <button
        v-if="hasMore"
        type="button"
        class="dropdown-more"
        :disabled="loadingMore"
        @click="() => void loadMore()"
      >
        {{ loadingMore ? '加载中…' : '加载更多' }}
      </button>
      <button type="button" class="dropdown-create" @click="emit('create')">＋ 新建会话</button>
    </footer>
  </div>
</template>

<style scoped lang="less">
// Teleport 到 body + fixed 定位（top/left/zIndex 由父级锚点计算，见 WorkbenchSessionBar）。
// 全直角 + token 色（--ink/--accent/--border + color-mix），浅深双端自适应。
.session-dropdown {
  position: fixed;
  display: flex;
  flex-direction: column;
  width: 280px;
  max-height: 360px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  background: var(--bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.dropdown-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.dropdown-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.dropdown-close {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  font-size: 12px;
  cursor: pointer;
  &:hover {
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 10%, transparent);
  }
}
.dropdown-list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.dropdown-row {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  &:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  &.is-active {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    .dropdown-row-preview {
      color: var(--accent);
    }
  }
}
.dropdown-row-select {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 8px 10px;
  box-sizing: border-box;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.dropdown-row-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
// 归档按钮：hover 行时出现（防误触），accent 描边小按钮。
.dropdown-row-archive {
  flex: 0 0 auto;
  align-self: center;
  width: 24px;
  height: 24px;
  margin-right: 6px;
  display: grid;
  place-items: center;
  padding: 0;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 12px;
  line-height: 1;
  opacity: 0;
  cursor: pointer;
  transition:
    opacity 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
  .dropdown-row:hover & {
    opacity: 1;
  }
  &:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
    color: var(--accent);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    opacity: 1;
  }
}
.dropdown-row-preview {
  overflow: hidden;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dropdown-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font:
    400 10px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
}
.dropdown-row-running {
  color: var(--accent);
  animation: dropdown-pulse 1.4s ease-in-out infinite;
}
@keyframes dropdown-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
.dropdown-row-pending {
  padding: 1px 4px;
  background: color-mix(in srgb, var(--accent) 20%, transparent);
  color: var(--accent);
}
.dropdown-state {
  flex: 1 1 auto;
  min-height: 80px;
  display: grid;
  place-items: center;
  gap: 8px;
  padding: 12px;
  color: color-mix(in srgb, var(--ink) 50%, transparent);
  font-size: 12px;
}
.dropdown-retry {
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 0;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
}
.dropdown-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
}
.dropdown-more,
.dropdown-create {
  padding: 5px 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 40%, transparent);
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 80%, transparent);
  font-size: 12px;
  cursor: pointer;
  &:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dropdown-row-running {
    animation: none;
  }
}
</style>
