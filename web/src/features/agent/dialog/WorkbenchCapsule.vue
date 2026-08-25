<script setup lang="ts">
/**
 * WorkbenchCapsule：节点树工作台每窗的最小化胶囊（Phase D）。
 * 独立渲染于 body（App.vue 按 workbenchWindowsList 中 minimized 的窗口），不随 shell v-show 隐藏。
 *   - 水平条：所有胶囊同基线（y 相同），x 按各自实测自然宽步进（DOM 实测 label 宽），后一个（z 更高）盖住前一个的按钮区、露出前一个名字。
 *   - 可拖：指针拖拽同步所有最小化胶囊的 capsulePos（拖动整个「条」），保持条布局。
 *   - hover：仅大幅抬升该胶囊 zIndex（不 reorder）。
 *   - 还原：胶囊尾部「还原」按钮（位于关闭前）→ setWorkbenchWindowMinimized(id,false) + focus，mode/position/size 已保留。
 *   - 关闭：尾部「关闭」按钮（结尾）→ closeWorkbenchWindow(id)。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

const props = defineProps<{ windowId: string }>()

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()

const win = computed(() => agents.workbenchWindows[props.windowId])

/** Phase E：该窗口需用户操作（审批/提问）时胶囊闪烁。点击还原/交互即熄灭。 */
const windowBlink = computed(() => win.value?.attentionBlink ?? false)

/** 当前最小化胶囊子集（按 z 序，末尾 = 最上层）。 */
const minimizedList = computed(() => agents.workbenchWindowsList.filter((w) => w.minimized))
const stackIndex = computed(() => {
  const idx = minimizedList.value.findIndex((w) => w.id === props.windowId)
  return idx === -1 ? 0 : idx
})

/** 胶囊标题：优先会话 preset 显示名，回退窗口 presetId / 占位。与 WorkbenchDialog 标题同源。 */
const title = computed(() => {
  const w = win.value
  if (!w) return ''
  const chatId = w.chatId
  if (chatId) {
    const s = chatSessions.sessionsById[chatId]
    if (s?.meta.preset) return s.meta.preset
    const h = agents.historyList.find((item) => item.chatId === chatId)
    if (h?.preset) return h.preset
  }
  return w.presetId || '节点树工作台'
})

/** 胶囊左内边距（px，与 CSS .workbench-capsule padding-left 一致）。 */
const CAPSULE_PAD_LEFT = 12
/** actions 与 label 的间距（px，与 CSS .workbench-capsule-actions margin-left 一致）。 */
const CAPSULE_ACTIONS_MARGIN = 6
/** 尾部操作区（还原+关闭）总宽（px，各 30px）。 */
const CAPSULE_ACTIONS_WIDTH = 60
/**
 * 相邻胶囊被后一个覆盖的量（px）：
 * step = 实测自然宽 - CAPSULE_OVERLAP，即后一个的左缘落在前一个按钮区起点，
 * 恰好盖住其按钮、露出其名字（额外留 EXPOSED_NAME_MARGIN 的空隙）。 */
const CAPSULE_OVERLAP = CAPSULE_ACTIONS_WIDTH + CAPSULE_ACTIONS_MARGIN - 6
/** 未挂载/未测得时的 label 回退宽度（px），避免条塌缩。 */
const DEFAULT_LABEL_WIDTH = 160
/** label 最大宽（px，与 CSS .workbench-capsule-label max-width 一致），防超长标题撑爆。 */
const MAX_LABEL_WIDTH = 200

/**
 * 各胶囊实测自然宽度（px）＝ padLeft + label 自然宽 + actionsMargin + actionsWidth。
 * 模块级共享，多个胶囊实例（每个窗口一个）读写同一份，供 renderPos 累加前驱宽度。 */
const measuredNaturalWidths = reactive<Record<string, number>>({})
const labelEl = ref<HTMLElement | null>(null)

function measuredWidth(windowId: string): number {
  return (
    measuredNaturalWidths[windowId] ??
    CAPSULE_PAD_LEFT + DEFAULT_LABEL_WIDTH + CAPSULE_ACTIONS_MARGIN + CAPSULE_ACTIONS_WIDTH
  )
}

/** DOM 实测本胶囊 label 自然宽（受 MAX_LABEL_WIDTH 截断），写入共享表。 */
function measureLabel(): void {
  const el = labelEl.value
  if (!el) return
  const labelWidth = Math.min(Math.ceil(el.scrollWidth), MAX_LABEL_WIDTH)
  measuredNaturalWidths[props.windowId] =
    CAPSULE_PAD_LEFT + labelWidth + CAPSULE_ACTIONS_MARGIN + CAPSULE_ACTIONS_WIDTH
}

onMounted(() => {
  measureLabel()
  window.addEventListener('resize', measureLabel)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measureLabel)
})
// title 变化后于下一 tick 重测（DOM 已更新 label 文本）。
watch(title, () => nextTick(measureLabel))

/**
 * 渲染位置：水平条。所有胶囊同基线（y = capsulePos.y），
 * x = base.x + Σ_{前驱}(前驱自然宽 - CAPSULE_OVERLAP)，后一个盖前一个按钮、名字露出。 */
const renderPos = computed(() => {
  const base = win.value?.capsulePos ?? { x: 16, y: 16 }
  let x = base.x
  for (let i = 0; i < stackIndex.value; i++) {
    const w = minimizedList.value[i]
    if (!w) break
    x += measuredWidth(w.id) - CAPSULE_OVERLAP
  }
  return { x, y: base.y }
})

const hovered = ref(false)
/** 胶囊永远高于所有工作台 shell（OVERLAY_Z_INDEX.composer + zOrder）；
 *  hover 大幅抬升（+1000）压过所有胶囊，露出被后一个遮挡的还原/关闭按钮。不 reorder。 */
const zIndex = computed(
  () => OVERLAY_Z_INDEX.composer + 1000 + stackIndex.value + (hovered.value ? 1000 : 0),
)

function restore(): void {
  agents.setWorkbenchWindowBlink(props.windowId, false)
  agents.setWorkbenchWindowMinimized(props.windowId, false)
  agents.focusWorkbenchWindow(props.windowId)
}
function close(): void {
  // 关闭工作台即关闭其 docked 历史抽屉：HistoryDrawer 读全局单例，不清理则抽屉及遮罩残留
  // （与 WorkbenchDialog.closeWorkbench 同款，见 docs/web/workbench-multi-window.md）。overlay 抽屉保留。
  if (agents.historyDrawerMode === 'workbench-docked') agents.closeAllHistory()
  const rootChatId = win.value?.chatId
  if (rootChatId) void chatSessions.releaseRootTimeline(rootChatId, `workbench:${props.windowId}`)
  agents.closeWorkbenchWindow(props.windowId)
}
function onHover(): void {
  hovered.value = true
  // 仅抬升 zIndex，不 focusWorkbenchWindow：hover 不改变蛇位/focus，避免扰动需注意消息的闪烁。
}
function onUnhover(): void {
  hovered.value = false
}

// ── 指针拖动（参考 useWorkbenchWindow 的 pointer capture 模式） ──
let dragCleanup: (() => void) | undefined
function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  if ((e.target as Element | null)?.closest('button')) return
  e.preventDefault()
  const base = win.value?.capsulePos ?? { x: 16, y: 16 }
  const start = { x: base.x, y: base.y }
  const startPointer = { x: e.clientX, y: e.clientY }
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture?.(e.pointerId)
  document.body.style.userSelect = 'none'
  const move = (me: PointerEvent) => {
    if (me.pointerId !== e.pointerId) return
    const next = {
      x: start.x + me.clientX - startPointer.x,
      y: start.y + me.clientY - startPointer.y,
    }
    // 拖动整个「条」：同步所有最小化胶囊位置，保持行完全对齐（避免单独拖动拆散对齐）。
    for (const w of agents.workbenchWindowsList) {
      if (w.minimized) agents.setWorkbenchWindowCapsulePos(w.id, next)
    }
  }
  const end = (ee: PointerEvent) => {
    if (ee.pointerId !== e.pointerId) return
    dragCleanup?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  dragCleanup = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    target.releasePointerCapture?.(e.pointerId)
    document.body.style.userSelect = ''
    dragCleanup = undefined
  }
}
</script>

<template>
  <div
    class="workbench-capsule"
    :class="{ 'has-attention': windowBlink }"
    :title="title"
    :style="{
      left: `${renderPos.x}px`,
      top: `${renderPos.y}px`,
      zIndex,
    }"
    @pointerdown="onPointerDown"
    @pointerenter="onHover"
    @pointerleave="onUnhover"
  >
    <span ref="labelEl" class="workbench-capsule-label" aria-hidden="true">{{ title }}</span>
    <div class="workbench-capsule-actions">
      <button
        type="button"
        class="workbench-capsule-restore"
        aria-label="还原节点树工作台"
        title="还原"
        @click.stop="restore"
      >
        <svg
          class="workbench-capsule-restore-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="4" width="7" height="6" rx="1.2" />
          <path d="M9 4V3.5A1.5 1.5 0 0 0 7.5 2H4" />
        </svg>
      </button>
      <button
        type="button"
        class="workbench-capsule-close"
        aria-label="关闭节点树工作台"
        title="关闭"
        @click.stop="close"
      >
        <span class="workbench-capsule-close-icon" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped lang="less">
.workbench-capsule {
  position: fixed;
  display: flex;
  align-items: center;
  height: 34px;
  padding: 0 0 0 12px;
  border-radius: 6px;
  color: color-mix(in srgb, var(--nx-text) 90%, transparent);
  background: color-mix(in srgb, var(--nx-bg) 94%, var(--nx-text) 6%);
  border: 1px solid color-mix(in srgb, var(--nx-text) 16%, transparent);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  user-select: none;
  transition:
    background-color 100ms ease,
    border-color 100ms ease;
}
.workbench-capsule:hover {
  background: color-mix(in srgb, var(--nx-text) 8%, var(--nx-bg));
  border-color: color-mix(in srgb, var(--nx-text) 30%, transparent);
}
// Phase E：需用户操作时胶囊暖橙外发光闪烁（非聚焦窗由 store 置位，点击还原熄灭）。
.workbench-capsule.has-attention {
  animation: workbench-capsule-blink 1.1s ease-in-out infinite;
}
@keyframes workbench-capsule-blink {
  0%,
  100% {
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    border-color: color-mix(in srgb, var(--nx-text) 16%, transparent);
  }
  50% {
    box-shadow: 0 0 16px 1px rgba(246, 183, 60, 0.6);
    border-color: rgba(246, 183, 60, 0.6);
  }
}
.workbench-capsule:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--nx-cyan) 86%, transparent);
  outline-offset: 1px;
}
.workbench-capsule-label {
  max-width: 200px; /* 防超长标题撑爆；实际宽度按文本自然撑开，由 script 实测 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}
// 尾部操作区：还原在前、关闭结尾，按钮全高贴边与胶囊融合。
.workbench-capsule-actions {
  display: flex;
  align-self: stretch;
  margin-left: 6px;
}
.workbench-capsule-restore,
.workbench-capsule-close {
  width: 30px;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-left: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
  color: color-mix(in srgb, var(--nx-text) 70%, transparent);
  background: transparent;
  cursor: pointer;
  transition:
    color 100ms ease,
    background-color 100ms ease;
}
.workbench-capsule-restore:hover,
.workbench-capsule-restore:focus-visible {
  color: var(--nx-text);
  background: color-mix(in srgb, var(--nx-text) 10%, transparent);
}
.workbench-capsule-close {
  border-radius: 0 6px 6px 0;
}
.workbench-capsule-close:hover,
.workbench-capsule-close:focus-visible {
  color: var(--nx-text);
  background: var(--nx-red);
}
.workbench-capsule-close-icon {
  position: relative;
  width: 10px;
  height: 10px;
}
.workbench-capsule-close-icon::before,
.workbench-capsule-close-icon::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 0;
  width: 10px;
  border-top: 1px solid currentcolor;
}
.workbench-capsule-close-icon::before {
  transform: rotate(45deg);
}
.workbench-capsule-close-icon::after {
  transform: rotate(-45deg);
}
</style>
