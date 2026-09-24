<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatSessionsStore, useTaskOverviewStore } from '@/application/public'
import type { TaskOverview } from '@/application/backend/public'
import {
  buildStripTooltip,
  dismissSessionStripTask,
  matchesSessionStripPreset,
  pickStripTasks,
  promoteSessionStripTask,
  reconcileSessionStripPreference,
  SESSION_STRIP_STABLE_SLOTS,
  sessionStripStatusIcon,
  sessionStripStatusLabel,
  taskIconIndex,
  type SessionStripItem,
  type TaskBrowserOpenRequest,
} from './useSessionStripTasks'
import { useSessionStripPreferences } from './useSessionStripPreferences'

const props = withDefaults(
  defineProps<{
    windowId: string
    presetId?: string
    presetName?: string
    activeChatId?: string | null
    /** 浏览器桌面内多窗口由父级传入；原生窗口缺省时使用 document.hasFocus()。 */
    foreground?: boolean
    allTasksExpanded?: boolean
  }>(),
  {
    presetId: undefined,
    presetName: undefined,
    activeChatId: null,
    foreground: undefined,
    allTasksExpanded: false,
  },
)

const emit = defineEmits<{
  select: [chatId: string]
  expand: [request: TaskBrowserOpenRequest]
}>()

const TASK_ICONS: ReadonlyArray<readonly string[]> = [
  ['M4 6h16v12H4z', 'M8 10h8', 'M8 14h5'],
  ['M12 3 5 7v10l7 4 7-4V7z', 'M12 3v18', 'm5-14 7 4 7-4'],
  ['M5 5h14v14H5z', 'm5 12 3 3 6-7 4 4'],
  ['M4 12h4l2-6 4 12 2-6h4'],
  ['M6 4h12v16H6z', 'M9 8h6', 'M9 12h6', 'M9 16h4'],
  ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M8 8l8 8', 'M16 8l-8 8'],
  ['M4 18V8l8-5 8 5v10', 'M8 21v-7h8v7'],
  ['M5 5h6v6H5z', 'M13 5h6v6h-6z', 'M5 13h6v6H5z', 'M13 13h6v6h-6z'],
]

const overview = useTaskOverviewStore()
const chats = useChatSessionsStore()
const preferenceScope = computed(() =>
  props.presetId
    ? `id:${props.presetId}`
    : props.presetName
      ? `name:${props.presetName}`
      : `window:${props.windowId}`,
)
const { preference, setPreference } = useSessionStripPreferences(preferenceScope)

const presetTasks = computed(() =>
  overview.tasks.filter((task) =>
    matchesSessionStripPreset(task, props.presetId, props.presetName),
  ),
)

// 当前打开的会话必须始终参与标题栏投影，即使它来自“全部任务”而不属于当前预设。
const stripTasks = computed(() => {
  const tasks = [...presetTasks.value]
  const activeTask = overview.tasks.find((task) => taskMatchesChat(task, props.activeChatId))
  if (activeTask && !tasks.some((task) => task.taskKey === activeTask.taskKey)) tasks.push(activeTask)
  return tasks
})

const knownChatIds = computed(
  () => new Set(chats.catalogSummaries.map((summary) => summary.chatId)),
)

const currentFallback = computed<SessionStripItem | undefined>(() => {
  const chatId = props.activeChatId?.trim()
  if (!chatId || stripTasks.value.some((task) => taskMatchesChat(task, chatId))) return undefined
  if (chats.catalogReady && !knownChatIds.value.has(chatId)) return undefined
  return {
    taskKey: chatId,
    rootChatId: chatId,
    originalChatId: chatId,
    openChatId: chatId,
    relatedChatIds: [],
    title: '当前会话',
    status: 'idle',
    unreadResult: false,
    attentionKey: `current:${chatId}`,
    pendingCount: 0,
    updatedAt: 0,
  }
})
// 标题栏预留固定槽位，宽度变化只影响是否显示溢出入口，不改变已分配槽位的顺序。
const visibleCapacity = ref(5)
const strip = computed(() =>
  pickStripTasks(
    preference.value,
    stripTasks.value,
    props.activeChatId ?? undefined,
    visibleCapacity.value,
    currentFallback.value,
  ),
)

watch(
  [stripTasks, () => props.activeChatId, preference, () => chats.catalogReady, knownChatIds],
  ([tasks, activeChatId]) => {
    setPreference(
      reconcileSessionStripPreference(
        preference.value,
        tasks,
        activeChatId ?? undefined,
        chats.catalogReady ? knownChatIds.value : undefined,
      ),
    )
  },
  { immediate: true },
)

function taskMatchesChat(task: TaskOverview, chatId: string | null | undefined): boolean {
  if (!chatId) return false
  return (
    task.taskKey === chatId ||
    task.rootChatId === chatId ||
    task.originalChatId === chatId ||
    task.openChatId === chatId ||
    task.agents.some((agent) => agent.chatId === chatId)
  )
}

const currentTaskKey = computed(
  () =>
    presetTasks.value.find((task) => taskMatchesChat(task, props.activeChatId))?.taskKey ??
    preference.value.slots.find((slot) =>
      [
        slot.snapshot.taskKey,
        slot.snapshot.rootChatId,
        slot.snapshot.originalChatId,
        slot.snapshot.openChatId,
        ...slot.snapshot.relatedChatIds,
      ].includes(props.activeChatId ?? ''),
    )?.taskKey,
)

function isCurrent(item: SessionStripItem): boolean {
  return item.taskKey === currentTaskKey.value
}

function isStored(item: SessionStripItem): boolean {
  return preference.value.slots.some((slot) => slot.taskKey === item.taskKey)
}

function iconPaths(item: SessionStripItem): readonly string[] {
  return TASK_ICONS[taskIconIndex(item.taskKey, TASK_ICONS.length)] ?? TASK_ICONS[0]!
}

function onSelect(item: SessionStripItem): void {
  closeTip()
  setPreference(promoteSessionStripTask(preference.value, item))
  emit('select', item.openChatId)
}

async function dismiss(item: SessionStripItem): Promise<void> {
  setPreference(dismissSessionStripTask(preference.value, item))
  closeTip()
  await nextTick()
  const focusTarget =
    document.getElementById(triggerId(item.taskKey)) ?? document.getElementById(allTasksId())
  focusTarget?.focus()
}

function formatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function accessibleLabel(item: SessionStripItem): string {
  const parts = [
    `切换任务：${buildStripTooltip(item).title}`,
    sessionStripStatusLabel(item.status),
  ]
  if (item.unreadResult) parts.push('有未查看结果')
  if (isCurrent(item)) parts.push('当前任务')
  parts.push('按向下键进入详情')
  return parts.join('，')
}

const itemsEl = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | undefined

function updateVisibleCapacity(_width: number): void {
  visibleCapacity.value = 5
}

const documentForeground = ref(true)
function syncDocumentForeground(): void {
  documentForeground.value = document.visibilityState === 'visible' && document.hasFocus()
}
const canAnimate = computed(
  () => props.foreground !== false && documentForeground.value,
)

const openTipKey = ref<string>()
let closeTimer: ReturnType<typeof setTimeout> | undefined

function triggerId(taskKey: string): string {
  return `session-strip-${props.windowId}-${taskKey}-trigger`
}

function tipId(taskKey: string): string {
  return `session-strip-${props.windowId}-${taskKey}-tip`
}

function allTasksId(): string {
  return `session-strip-${props.windowId}-all-tasks`
}

function cancelTipClose(): void {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = undefined
}

function openTip(taskKey: string): void {
  cancelTipClose()
  openTipKey.value = taskKey
}

function closeTip(): void {
  cancelTipClose()
  openTipKey.value = undefined
}

function scheduleTipClose(taskKey: string): void {
  cancelTipClose()
  closeTimer = setTimeout(() => {
    if (openTipKey.value === taskKey) openTipKey.value = undefined
  }, 120)
}

async function enterTip(item: SessionStripItem): Promise<void> {
  openTip(item.taskKey)
  await nextTick()
  document.getElementById(tipId(item.taskKey))?.focus()
}

function onReferenceKeydown(event: KeyboardEvent, item: SessionStripItem): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    void enterTip(item)
  } else if (event.key === 'Escape') {
    closeTip()
  }
}

async function returnToTrigger(item: SessionStripItem): Promise<void> {
  closeTip()
  await nextTick()
  document.getElementById(triggerId(item.taskKey))?.focus()
}

function openAllTasks(): void {
  emit('expand', { focus: strip.value.attentionCount > 0 ? 'attention' : 'all' })
}

const allTasksLabel = computed(() => {
  const parts = [props.allTasksExpanded ? '关闭任务列表' : '打开全部任务']
  if (strip.value.overflowCount > 0) parts.push(`${strip.value.overflowCount} 个任务未显示在标题栏`)
  if (strip.value.attentionCount > 0) parts.push(`${strip.value.attentionCount} 个任务需要关注`)
  return parts.join('，')
})

onMounted(() => {
  syncDocumentForeground()
  window.addEventListener('focus', syncDocumentForeground)
  window.addEventListener('blur', syncDocumentForeground)
  document.addEventListener('visibilitychange', syncDocumentForeground)
  if (itemsEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) updateVisibleCapacity(entry.contentRect.width)
    })
    resizeObserver.observe(itemsEl.value)
    updateVisibleCapacity(itemsEl.value.getBoundingClientRect().width)
  }
})

onBeforeUnmount(() => {
  cancelTipClose()
  resizeObserver?.disconnect()
  window.removeEventListener('focus', syncDocumentForeground)
  window.removeEventListener('blur', syncDocumentForeground)
  document.removeEventListener('visibilitychange', syncDocumentForeground)
})
</script>

<template>
  <div class="session-strip" :class="{ 'can-animate': canAnimate }" role="group" aria-label="任务切换">
    <div ref="itemsEl" class="session-strip-items">
      <el-popover
        v-for="item in strip.items"
        :key="item.taskKey"
        :visible="openTipKey === item.taskKey"
        trigger="manual"
        placement="bottom"
        :width="320"
        popper-class="session-strip-tip"
      >
        <template #reference>
          <button
            :id="triggerId(item.taskKey)"
            type="button"
            class="session-strip-icon"
            :class="{
              'is-active': isCurrent(item),
              'is-ghost': item.ghost,
              'is-needs-user': item.status === 'needs_user',
              'is-failed': item.status === 'failed',
            }"
            :aria-label="accessibleLabel(item)"
            :aria-pressed="isCurrent(item)"
            :aria-describedby="openTipKey === item.taskKey ? tipId(item.taskKey) : undefined"
            @click="onSelect(item)"
            @mouseenter="openTip(item.taskKey)"
            @mouseleave="scheduleTipClose(item.taskKey)"
            @focus="openTip(item.taskKey)"
            @blur="scheduleTipClose(item.taskKey)"
            @keydown="onReferenceKeydown($event, item)"
          >
            <svg class="strip-main-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path v-for="path in iconPaths(item)" :key="path" :d="path" />
            </svg>
            <span
              class="strip-status-icon"
              :class="`is-${item.status}`"
              :title="sessionStripStatusLabel(item.status)"
              aria-hidden="true"
            >
              {{ sessionStripStatusIcon(item.status) }}
            </span>
            <span v-if="item.unreadResult" class="strip-unread-mark" aria-hidden="true" />
            <span v-if="isCurrent(item)" class="strip-current-bar" aria-hidden="true" />
          </button>
        </template>

        <section
          :id="tipId(item.taskKey)"
          class="session-strip-tip-body"
          tabindex="-1"
          :aria-label="`${buildStripTooltip(item).title}任务详情`"
          @mouseenter="cancelTipClose"
          @mouseleave="scheduleTipClose(item.taskKey)"
          @focusin="cancelTipClose"
          @focusout="scheduleTipClose(item.taskKey)"
          @keydown.esc.stop.prevent="returnToTrigger(item)"
        >
          <header class="tip-head">
            <span class="tip-title">{{ buildStripTooltip(item).title }}</span>
            <span class="tip-status">{{ buildStripTooltip(item).status }}</span>
          </header>
          <div class="tip-section">
            <span class="tip-label">最近要求</span>
            <span class="tip-value">{{ buildStripTooltip(item).lastPrompt }}</span>
          </div>
          <div class="tip-section">
            <span class="tip-label">{{ buildStripTooltip(item).detailLabel }}</span>
            <span
              class="tip-value"
              :class="{
                'is-result': item.status !== 'running' && item.status !== 'needs_user' && !!item.latestResult,
              }"
            >{{ buildStripTooltip(item).detail }}</span>
          </div>
          <footer class="tip-foot">
            <time :datetime="new Date(item.updatedAt).toISOString()">
              更新于 {{ formatUpdatedAt(item.updatedAt) }}
            </time>
            <button v-if="isStored(item)" type="button" @click="dismiss(item)">
              从标题栏收起
            </button>
            <span v-else>当前任务补位，切换后自动离开</span>
          </footer>
        </section>
      </el-popover>
      <span
        v-for="index in Math.max(0, SESSION_STRIP_STABLE_SLOTS - strip.items.length)"
        :key="`empty-${index}`"
        class="session-strip-placeholder"
        aria-hidden="true"
      />
    </div>

    <button
      :id="allTasksId()"
      type="button"
      class="session-strip-all"
      :class="{
        'is-expanded': allTasksExpanded,
        'has-attention': strip.attentionCount > 0,
      }"
      :aria-label="allTasksLabel"
      :aria-pressed="allTasksExpanded"
      :aria-expanded="allTasksExpanded"
      @click="openAllTasks"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 6h14M5 12h14M5 18h14" />
        <path d="M3 6h.01M3 12h.01M3 18h.01" />
      </svg>
      <span v-if="strip.overflowCount" class="all-overflow" aria-hidden="true">
        +{{ strip.overflowCount > 9 ? '9' : strip.overflowCount }}
      </span>
      <span v-if="strip.attentionCount" class="all-attention" aria-hidden="true">!</span>
    </button>
  </div>
</template>

<style scoped lang="less">
.session-strip {
  display: flex;
  flex: 1 1 218px;
  align-items: center;
  gap: 6px;
  min-width: 58px;
  max-width: 218px;
  overflow: hidden;
}
.session-strip-items {
  display: flex;
  flex: 1 1 186px;
  align-items: center;
  gap: 6px;
  min-width: 26px;
  height: 34px;
  padding: 4px 0;
  box-sizing: border-box;
  overflow: hidden;
}
.session-strip-icon,
.session-strip-all {
  position: relative;
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 0;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--ink) 30%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--ink);
  cursor: pointer;
  overflow: visible;
  transition:
    border-color 120ms ease,
    background 120ms ease,
    transform 120ms ease;
  &:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    transform: translateY(-1px);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
}
.session-strip-placeholder {
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  box-sizing: border-box;
  border: 1px dashed color-mix(in srgb, var(--ink) 18%, transparent);
  background: color-mix(in srgb, var(--ink) 3%, transparent);
}
.session-strip-icon {
  &.is-active {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent), 0 0 12px var(--accent-glow);
  }
  &.is-ghost {
    opacity: 0.42;
    border-style: dashed;
    background: color-mix(in srgb, var(--ink) 4%, transparent);
  }
  &.is-needs-user,
  &.is-failed {
    border-color: color-mix(in srgb, var(--accent) 72%, transparent);
  }
}
.strip-main-icon,
.session-strip-all > svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: square;
  stroke-linejoin: miter;
}
.session-strip-icon.is-active .strip-main-icon {
  /* 高亮底色是 --accent，图标必须用 --accent-ink 才能在底色上清晰可见；
     与「全部任务」展开按钮（.session-strip-all.is-expanded）的高亮一致，
     此前误用 --accent 导致图标与底色同色不可见（reduced-motion 下更彻底不可见）。 */
  color: var(--accent-ink);
  filter: drop-shadow(-1px 0 color-mix(in srgb, var(--accent) 75%, white))
    drop-shadow(1px 0 color-mix(in srgb, var(--accent) 75%, black));
  animation: session-active-signal 0.85s steps(2, end) infinite;
}
@keyframes session-active-signal {
  0%, 100% { transform: translate(0, 0) skewX(0deg) scale(1); }
  18% { transform: translate(-1px, 0) skewX(-8deg) scale(1.08); }
  42% { transform: translate(1px, 1px) skewX(9deg) scale(.94); }
  66% { transform: translate(-1px, 0) skewX(-5deg) scale(1.05); }
  84% { transform: translate(1px, 0) skewX(4deg) scale(.98); }
}
.strip-status-icon {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 11px;
  height: 11px;
  display: grid;
  place-items: center;
  border: 1px solid var(--panel);
  border-radius: 0;
  background: var(--panel);
  color: var(--ink);
  font: 400 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  &.is-running,
  &.is-needs_user,
  &.is-failed {
    color: var(--accent);
  }
}
.can-animate .strip-status-icon.is-running {
  animation: strip-running-signal 1.35s ease-in-out infinite;
}
@keyframes strip-running-signal {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
.strip-unread-mark {
  position: absolute;
  left: -3px;
  bottom: -3px;
  width: 6px;
  height: 6px;
  border: 1px solid var(--panel);
  border-radius: 0;
  background: var(--accent);
}
.strip-current-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--accent);
}
.session-strip-all {
  flex: 0 0 26px;
  /* 覆盖页展开时高亮（与任务图标当前态同款），按钮本身承担开/关切换。 */
  &.is-expanded {
    border-color: var(--accent);
    background: var(--accent) !important;
    color: var(--accent-ink) !important;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent), 0 0 12px var(--accent-glow);
  }
  &.has-attention {
    border-color: var(--accent);
  }
}
.session-strip-all.is-expanded > svg,
.session-strip-all:hover > svg {
  animation: session-all-tasks-signal 1.1s steps(2, end) infinite;
  filter: drop-shadow(-1px 0 color-mix(in srgb, var(--accent) 75%, #f44))
    drop-shadow(1px 0 color-mix(in srgb, var(--accent) 70%, #4ff));
}
@keyframes session-all-tasks-signal {
  0%, 100% { transform: translate(0, 0) skewX(0deg); }
  25% { transform: translate(-1px, 0) skewX(-4deg); }
  50% { transform: translate(1px, 1px) skewX(5deg); }
  75% { transform: translate(-1px, 0) skewX(-2deg); }
}
.all-overflow,
.all-attention {
  position: absolute;
  display: grid;
  place-items: center;
  min-width: 11px;
  height: 11px;
  padding: 0 1px;
  box-sizing: border-box;
  border: 1px solid var(--panel);
  border-radius: 0;
  background: var(--panel);
  color: var(--accent);
  font: 400 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.all-overflow {
  right: -5px;
  bottom: -5px;
}
.all-attention {
  top: -4px;
  right: -4px;
}
@media (prefers-reduced-motion: reduce) {
  .session-strip-icon,
  .session-strip-all {
    transition: none;
  }
  .strip-status-icon.is-running {
    animation: none;
    opacity: 1;
  }
  .session-strip-icon.is-active .strip-main-icon {
    animation: none;
    filter: none;
  }
  .session-strip-all.is-expanded > svg,
  .session-strip-all:hover > svg {
    animation: none;
    filter: none;
  }
}
</style>

<style lang="less">
.session-strip-tip.el-popover.el-popper {
  padding: 0;
  border-radius: 0;
  font-weight: 400;
}
.session-strip-tip-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  color: var(--ink);
  font-size: 14px;
  font-weight: 400;
  outline: none;
}
.session-strip-tip-body .tip-head,
.session-strip-tip-body .tip-foot {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.session-strip-tip-body .tip-title {
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.45;
  word-break: break-word;
}
.session-strip-tip-body .tip-status {
  flex: 0 0 auto;
  color: var(--accent);
  font-weight: 400;
}
.session-strip-tip-body .tip-section {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 18%, transparent);
}
.session-strip-tip-body .tip-label {
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 14px;
  font-weight: 400;
}
.session-strip-tip-body .tip-value {
  line-height: 1.55;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.session-strip-tip-body .tip-value.is-result {
  display: block;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.session-strip-tip-body .tip-foot {
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 18%, transparent);
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  line-height: 24px;
}
.session-strip-tip-body .tip-foot button {
  flex: 0 0 auto;
  min-height: 24px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--ink) 30%, transparent);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-size: 14px;
  font-weight: 400;
  cursor: pointer;
  &:hover,
  &:focus-visible {
    border-color: var(--accent);
    color: var(--accent);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
}
</style>
