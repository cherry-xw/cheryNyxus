<script setup lang="ts">
/**
 * NexusPianoStrip：对话框底部边框线「外挂」的标准钢琴键盘。
 * 挂在 .dialog-panel.is-nyxus-panel 之外（position:absolute; top:100%），如琴键从琴体下沿伸出。
 * 琴键数量严格等于 Nexus 根历史会话数量；会话按 createdAt 升序从左到右占连续键。
 * 运行中且有 pending 审批 → 该键闪烁（临近过期加速）；选中键高亮。
 * 静音开关与新建会话钮均已移至 AgentDialog 标题栏（共享 usePianoAudio 单例 muted）。
 */
import { computed, onBeforeUnmount, onMounted, onScopeDispose, ref } from 'vue'
import { ElTooltip } from 'element-plus'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'
import type { ApprovalState } from '@/stores/agents'
import type { ChatSummary } from '@/services/agentApi'
import {
  BASE_MIDI,
  isBlackKey,
  layoutPianoKeys,
  sessionPianoKeyCount,
  WHITE_W,
  type PianoKeyGeom,
} from '../composables/pianoNotes'
import { usePianoAudio } from '../composables/usePianoAudio'
import { useDragPan } from '../composables/useDragPan'
import { useNow } from '@/features/pets/composables/useNow'
import { remainingSecOf, flashPeriodOf, isExpired } from '@/features/pets/utils/approvalTiming'

const emit = defineEmits<{
  select: [chatId: string]
  delete: [chatId: string]
}>()

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const audio = usePianoAudio()
const now = useNow(250)

/** Nexus 主会话（root + cheryNyxus），createdAt 升序 → chromatic 占键。 */
const sessions = computed<ChatSummary[]>(() =>
  (agents.historyList ?? [])
    .filter((c) => !c.parentChatId && c.preset === CHERY_NYXUS_PRESET)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
)

/** 一条根历史会话对应一枚琴键，不渲染无数据占位键。 */
const renderCount = computed(() => sessionPianoKeyCount(sessions.value.length))

/** 渲染范围内的白键数（fit 模式均分分母）。 */
const whiteCount = computed(() => {
  let n = 0
  for (let i = 0; i < renderCount.value; i++) if (!isBlackKey(BASE_MIDI + i)) n++
  return n
})

/**
 * fit 判定：固定 32px 白键轨宽 ≤ 视口宽 → 白键按比例均分填满视口（消除右侧空隙）；
 * 会话多于标准键（轨宽明显大于视口）→ 固定 32px + 拖拽。viewportW 由 ResizeObserver 实时测。
 */
const viewportW = ref(0)
// 键盘外框内边距和边线最多吞掉 8px；标准琴键不应因此出现无意义的横向滚动。
const FIT_TOLERANCE_PX = 8
const fitMode = computed(
  () =>
    viewportW.value > 0 &&
    whiteCount.value > 0 &&
    whiteCount.value * WHITE_W <= viewportW.value + FIT_TOLERANCE_PX,
)
const layout = computed(() =>
  layoutPianoKeys(renderCount.value, { fillWidth: fitMode.value ? viewportW.value : 0 }),
)

const viewportRef = ref<HTMLElement | null>(null)
const drag = useDragPan({
  viewportWidth: () => viewportRef.value?.clientWidth ?? 0,
  contentWidth: () => layout.value.trackWidth,
})

// 视口宽实时测量 → 驱动 fit 模式（白键均分填满，消除右侧空隙）。
let pianoRO: ResizeObserver | null = null
onMounted(() => {
  const el = viewportRef.value
  if (!el) return
  viewportW.value = el.clientWidth
  pianoRO = new ResizeObserver(() => {
    viewportW.value = el.clientWidth
  })
  pianoRO.observe(el)
})
onBeforeUnmount(() => {
  pianoRO?.disconnect()
  pianoRO = null
})

interface KeyView {
  geom: PianoKeyGeom
  hasData: boolean
  chatId: string
  selected: boolean
  blink: boolean
  flashPeriod: number
  time: string
  tip: string
  approval?: ApprovalState
  /** 可删除：有数据 && 非运行中 && 无 pending 审批。 */
  deletable: boolean
}

const keyViews = computed<KeyView[]>(() => {
  const sess = sessions.value
  return layout.value.keys.map((g, i): KeyView => {
    const summary = sess[i]
    if (!summary) {
      // sessions/layout 同源；该保护仅防御异步列表切换瞬间的短暂索引错位。
      return {
        geom: g,
        hasData: false,
        chatId: '',
        selected: false,
        blink: false,
        flashPeriod: 5,
        time: '',
        tip: `${g.name} · MIDI ${g.midi}`,
        deletable: false,
      }
    }
    const session = chatSessions.sessionsById[summary.chatId]
    const hydrated = session?.interaction.approval
    const listed = summary.pendingApproval ?? undefined
    const approval: ApprovalState | undefined =
      hydrated ??
      (listed
        ? {
            approvalId: '',
            senseName: listed.senseName,
            waitTime: listed.waitTime,
            createdAt: listed.createdAt,
          }
        : undefined)
    const running = session?.run.status === 'running' || summary.running === true
    const blink = running && !!approval && !isExpired(approval, now.value)
    const prev = summary.preview?.trim()
    return {
      geom: g,
      hasData: true,
      chatId: summary.chatId,
      selected: summary.chatId === agents.activeNyxusChatId,
      blink,
      flashPeriod: approval ? flashPeriodOf(approval, now.value) : 5,
      time: formatTime(summary.createdAt),
      tip: `${g.name} · MIDI ${g.midi} · ${prev || '无消息'}`,
      approval,
      deletable: !running && !approval,
    }
  })
})

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

function keyStyle(v: KeyView): Record<string, string | undefined> {
  return {
    left: `${v.geom.left}px`,
    width: `${v.geom.width}px`,
    height: `${v.geom.height}px`,
    zIndex: String(v.geom.z),
    '--flash-period': v.blink ? `${v.flashPeriod}s` : undefined,
  }
}

function formatCountdown(v: KeyView): string {
  const a = v.approval
  if (!a) return ''
  return `${Math.ceil(remainingSecOf(a, now.value))}s`
}

function onKeyClick(v: KeyView): void {
  // 拖拽后的 click 不触发选键/发声。
  if (drag.wasDrag.value) return
  void audio.play(v.geom.freq)
  if (v.hasData) emit('select', v.chatId)
}

const pressedKeyId = ref<number | null>(null)
let pressedPointerId = -1

function onKeyDown(e: PointerEvent, v: KeyView): void {
  pressedKeyId.value = v.geom.index
  pressedPointerId = e.pointerId
  window.addEventListener('pointerup', onKeyUp)
  window.addEventListener('pointercancel', onKeyUp)
}

function onKeyUp(e: PointerEvent): void {
  if (e.pointerId !== pressedPointerId) return
  pressedKeyId.value = null
  pressedPointerId = -1
  window.removeEventListener('pointerup', onKeyUp)
  window.removeEventListener('pointercancel', onKeyUp)
}

// ── 拖拽删除（二次确认 = 拖到右侧垃圾桶释放，不开弹窗） ──
// hover 可删键 -> 键下方显清除 icon；按住 icon 拖拽 -> 右侧固定垃圾桶 + callout 出现；
// 释放在垃圾桶上 -> emit delete。运行中/pending 审批键不可删（deletable=false，icon 不显）。
const hoveredIdx = ref<number | null>(null)
const hoveredKeyView = computed<KeyView | null>(() =>
  hoveredIdx.value != null ? (keyViews.value[hoveredIdx.value] ?? null) : null,
)
/** 清除按钮中心与 hover 键中心对齐（相对 piano-keyboard 左缘）。 */
const clearIconLeft = computed(() => {
  const v = hoveredKeyView.value
  if (!v) return 0
  // 绝对定位相对 .piano-keyboard；琴键轨在其左右 6px 内边距之后。
  return 6 + v.geom.left + drag.offsetX.value + v.geom.width / 2
})
/** 删除按钮贴琴键底边下方。 */
const clearIconTop = computed(() => (hoveredKeyView.value?.geom.height ?? 0) - 3)

const trashRef = ref<HTMLElement | null>(null)
const clearDrag = ref<{ chatId: string } | null>(null)
const ghostX = ref(0)
const ghostY = ref(0)
const overTrash = ref(false)
const dumping = ref(false)
let clearPointerId = -1
let dumpTimer: ReturnType<typeof setTimeout> | undefined
let hoverLeaveTimer: ReturnType<typeof setTimeout> | undefined

function hitTrash(x: number, y: number): boolean {
  const el = trashRef.value
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}
function onClearMove(e: PointerEvent): void {
  if (clearPointerId !== e.pointerId) return
  ghostX.value = e.clientX
  ghostY.value = e.clientY
  overTrash.value = hitTrash(e.clientX, e.clientY)
}
function onClearUp(e: PointerEvent): void {
  if (clearPointerId !== e.pointerId) return
  const hit = hitTrash(e.clientX, e.clientY)
  const chatId = clearDrag.value?.chatId
  clearPointerId = -1
  clearDrag.value = null
  overTrash.value = false
  window.removeEventListener('pointermove', onClearMove)
  window.removeEventListener('pointerup', onClearUp)
  window.removeEventListener('pointercancel', onClearUp)
  if (hit && chatId) {
    // 释放命中垃圾桶：先播倒掉动画，动画结束后再删除数据。
    dumping.value = true
    dumpTimer = setTimeout(() => {
      dumping.value = false
      dumpTimer = undefined
      emit('delete', chatId)
    }, 650)
  }
}
function cancelHoverLeave(): void {
  if (hoverLeaveTimer) {
    clearTimeout(hoverLeaveTimer)
    hoverLeaveTimer = undefined
  }
}
function scheduleHoverLeave(): void {
  // 延迟清空 hoveredIdx：给 pointer 从琴键跨间隙/邻键移到清除 icon 的时间。
  cancelHoverLeave()
  hoverLeaveTimer = setTimeout(() => {
    hoveredIdx.value = null
    hoverLeaveTimer = undefined
  }, 150)
}
function onKeyEnter(v: KeyView): void {
  cancelHoverLeave()
  hoveredIdx.value = v.geom.index
}
function onKeyLeave(e: PointerEvent, v: KeyView): void {
  // 移向清除 icon 时保持（relatedTarget 命中 icon）。
  const rt = e.relatedTarget
  if (rt instanceof Element && rt.closest('.key-clear-icon')) return
  if (hoveredIdx.value !== v.geom.index) return
  scheduleHoverLeave()
}
function onIconEnter(): void {
  cancelHoverLeave()
}
function onIconLeave(e: PointerEvent): void {
  const rt = e.relatedTarget
  if (rt instanceof Element && rt.closest('.piano-key')) return
  scheduleHoverLeave()
}
function onClearDown(e: PointerEvent, v: KeyView): void {
  if (!v.deletable) return
  // 阻断冒泡到 piano-viewport 的 useDragPan 平移（icon 在 viewport 外，仍保险）。
  e.stopPropagation()
  e.preventDefault()
  clearPointerId = e.pointerId
  clearDrag.value = { chatId: v.chatId }
  ghostX.value = e.clientX
  ghostY.value = e.clientY
  window.addEventListener('pointermove', onClearMove)
  window.addEventListener('pointerup', onClearUp)
  window.addEventListener('pointercancel', onClearUp)
}
onScopeDispose(() => {
  window.removeEventListener('pointerup', onKeyUp)
  window.removeEventListener('pointercancel', onKeyUp)
  if (dumpTimer) {
    clearTimeout(dumpTimer)
    dumpTimer = undefined
  }
  if (hoverLeaveTimer) {
    clearTimeout(hoverLeaveTimer)
    hoverLeaveTimer = undefined
  }
  dumping.value = false
  if (clearPointerId === -1) return
  clearPointerId = -1
  clearDrag.value = null
  window.removeEventListener('pointermove', onClearMove)
  window.removeEventListener('pointerup', onClearUp)
  window.removeEventListener('pointercancel', onClearUp)
})
</script>

<template>
  <div class="piano-keyboard">
    <div
      ref="viewportRef"
      class="piano-viewport"
      @pointerdown="drag.onPointerDown"
      @pointermove="drag.onPointerMove"
      @pointerup="drag.onPointerUp"
      @pointercancel="drag.onPointerUp"
      @wheel.prevent="drag.onWheel"
    >
      <div
        v-if="keyViews.length"
        class="piano-track"
        :style="{
          width: layout.trackWidth + 'px',
          transform: `translateX(${drag.offsetX.value}px)`,
        }"
      >
        <ElTooltip
          v-for="v in keyViews"
          :key="v.geom.index"
          :content="v.tip"
          placement="top"
          :show-after="260"
        >
          <button
            type="button"
            class="piano-key"
            :class="[
              v.geom.isBlack ? 'is-black' : 'is-white',
              {
                'is-nodata': !v.hasData,
                'is-active': v.hasData && v.selected,
                'is-pressed': v.geom.index === pressedKeyId,
                'is-blink': v.blink,
              },
            ]"
            :style="keyStyle(v)"
            :aria-disabled="!v.hasData"
            @click="onKeyClick(v)"
            @pointerdown="onKeyDown($event, v)"
            @pointerenter="onKeyEnter(v)"
            @pointerleave="onKeyLeave($event, v)"
          >
            <span v-if="v.geom.isBlack" class="key-black-face">
              <span v-if="v.blink" class="key-countdown is-on-black">{{ formatCountdown(v) }}</span>
              <span v-if="v.hasData" class="key-time is-on-black">{{ v.time }}</span>
            </span>
            <span v-else class="key-face">
              <span v-if="v.blink" class="key-countdown">{{ formatCountdown(v) }}</span>
              <span v-if="v.hasData" class="key-time">{{ v.time }}</span>
            </span>
            <span v-if="v.selected" class="key-selected-marker" aria-hidden="true" />
          </button>
        </ElTooltip>
      </div>
      <div v-else class="piano-empty">暂无历史会话</div>
    </div>
    <!-- 清除按钮：hover 可删键时在其底部中心显示，按住拖到垃圾桶才删除。 -->
    <button
      v-if="hoveredKeyView?.deletable"
      type="button"
      class="key-clear-icon"
      :style="{ left: clearIconLeft + 'px', top: clearIconTop + 'px' }"
      title="拖到右侧垃圾桶删除该会话"
      @pointerdown="onClearDown($event, hoveredKeyView!)"
      @pointerenter="onIconEnter"
      @pointerleave="onIconLeave($event)"
    >
      <span class="key-clear-glyph" aria-hidden="true">×</span>
    </button>
    <!-- 拖拽目标垃圾桶（右侧固定）+ callout 标签 -->
    <div v-if="clearDrag || dumping" class="trash-dropzone" :class="{ 'is-over': overTrash }">
      <span ref="trashRef" class="trash-icon" :class="{ 'is-dumping': dumping }">
        <svg class="trash-svg" viewBox="0 0 24 24" aria-hidden="true">
          <g class="trash-lid">
            <rect x="5" y="5" width="14" height="2.2" rx="0.6" />
            <rect x="10" y="2.6" width="4" height="2.6" rx="0.6" />
          </g>
          <g class="trash-body">
            <path d="M6.5 8 L17.5 8 L16.3 21 H7.7 Z" />
            <line class="trash-content" x1="9.5" y1="11" x2="9.5" y2="18" />
            <line class="trash-content" x1="12" y1="11" x2="12" y2="18" />
            <line class="trash-content" x1="14.5" y1="11" x2="14.5" y2="18" />
          </g>
        </svg>
      </span>
      <span class="trash-callout">拖到此处删除该会话</span>
    </div>
    <!-- 拖拽幽灵（fixed 跟随光标） -->
    <div v-if="clearDrag" class="clear-ghost" :style="{ left: ghostX + 'px', top: ghostY + 'px' }">
      <svg class="sticker-svg ghost-sticker" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4 H14 L20 10 V20 H5 Z" />
        <path d="M14 4 V10 H20 Z" />
      </svg>
    </div>
  </div>
</template>

<style scoped lang="less">
// 外挂于 .dialog-panel.is-nyxus-panel（position:relative）底边框线之外。
.piano-keyboard {
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  z-index: 5;
  display: flex;
  flex-direction: column;
  padding: 0 6px 6px;
  box-sizing: border-box;
}

.piano-viewport {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(48, 25, 7, 0.84);
  border-top: 1px solid rgba(255, 223, 157, 0.48);
  border-radius: 3px 3px 8px 8px;
  background: #32200f;
  box-shadow:
    0 5px 10px rgba(0, 0, 0, 0.38),
    inset 0 1px 0 rgba(255, 239, 200, 0.22);
  cursor: grab;
  touch-action: none;
}
.piano-empty {
  min-height: 112px;
  display: grid;
  place-items: center;
  color: rgba(255, 239, 205, 0.58);
  font:
    600 11px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  letter-spacing: 0.08em;
}
.piano-viewport:active {
  cursor: grabbing;
}

.piano-track {
  position: relative;
  height: 112px;
}

// ── 真实钢琴键外观 ──
.piano-key {
  position: absolute;
  top: 0;
  padding: 0;
  border: 0;
  cursor: pointer;
  touch-action: none;
  transition:
    filter 70ms ease,
    transform 70ms ease;

  // 白键：象牙色长键，前缘圆角 + 侧缝 + 前端阴影。
  &.is-white {
    background: linear-gradient(180deg, #fffefb 0%, #fbf6ec 55%, #efe4cd 100%);
    border-right: 1px solid rgba(120, 100, 60, 0.28);
    border-radius: 0 0 5px 5px;
    color: #6b5436;
    &:last-child {
      border-right: 0;
    }
  }
  // 黑键：乌木质感，短而居上，亮顶高光 + 前端圆角 + 投影到白键。
  &.is-black {
    background: linear-gradient(180deg, #4a4239 0%, #1d1813 55%, #080706 100%);
    border-radius: 0 0 3px 3px;
    box-shadow:
      inset 0 -2px 3px rgba(0, 0, 0, 0.7),
      inset 0 2px 1px rgba(255, 255, 255, 0.14),
      0 3px 4px rgba(0, 0, 0, 0.45);
    color: #d8cdb6;
  }

  &:hover {
    filter: brightness(1.04);
  }
  &.is-white:not(.is-nodata):active {
    background: linear-gradient(180deg, #f7f1e3 0%, #f1e8d3 60%, #e6d9bd 100%);
  }
  &.is-pressed {
    filter: saturate(1.12);
  }
  &.is-white.is-pressed {
    background: linear-gradient(180deg, #ffe7a0 0%, #f6bb4b 58%, #d88626 100%);
    color: #62400c;
  }
  &.is-black.is-pressed {
    background: linear-gradient(180deg, #9a6328 0%, #593212 55%, #2e1908 100%);
  }
  &.is-blink {
    animation: nx-key-flash var(--flash-period, 1s) ease-in-out infinite;
  }

  // 无数据键：置灰不可用。
  &.is-nodata {
    cursor: pointer;
    &.is-white {
      background: linear-gradient(180deg, #dedacf 0%, #cdc8bf 60%, #bdb8af 100%);
      box-shadow:
        inset 0 -4px 5px rgba(120, 110, 90, 0.18),
        inset 2px 0 0 rgba(255, 255, 255, 0.4);
      color: #9a958c;
    }
    &.is-black {
      background: linear-gradient(180deg, #5e5950 0%, #3a3631 60%, #2a2622 100%);
      box-shadow:
        inset 0 -2px 3px rgba(0, 0, 0, 0.5),
        inset 0 2px 1px rgba(255, 255, 255, 0.08);
      color: #7a766e;
    }
  }
}

// 当前会话标记：仅占键体内的一个小金点，不改动琴键圆角、阴影或层级。
.key-selected-marker {
  position: absolute;
  top: 7px;
  left: 50%;
  width: 6px;
  height: 6px;
  transform: translateX(-50%);
  border: 1px solid rgba(92, 52, 9, 0.65);
  border-radius: 50%;
  background: #f6b73c;
  box-shadow: 0 1px 2px rgba(56, 29, 5, 0.35);
  pointer-events: none;
}

// 白键键面文字（底端）。
.key-face {
  position: absolute;
  inset: auto 0 5px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  line-height: 1;
  pointer-events: none;
}
.key-time {
  font-size: 8px;
  color: #6b4a20;
  opacity: 0.9;
  font-weight: 700;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.key-black-face {
  position: absolute;
  inset: auto 0 4px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  pointer-events: none;
}
.key-time.is-on-black {
  color: rgba(255, 244, 216, 0.94);
  font-size: 7px;
  text-shadow: 0 1px 1px #000;
}

.key-countdown {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 9px;
  font-weight: 800;
  color: #b94a1f;
  text-shadow: 0 0 4px rgba(255, 255, 255, 0.85);
  &.is-on-black {
    color: #ffb27a;
    text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
  }
}

@keyframes nx-key-flash {
  0%,
  100% {
    opacity: 1;
    box-shadow:
      0 0 0 2px rgba(185, 74, 31, 0.85),
      0 0 8px rgba(185, 74, 31, 0.55),
      inset 0 -3px 5px rgba(150, 120, 60, 0.2);
  }
  50% {
    opacity: 0.45;
    box-shadow:
      0 0 0 2px rgba(246, 183, 60, 0.85),
      0 0 5px rgba(246, 183, 60, 0.4),
      inset 0 -3px 5px rgba(150, 120, 60, 0.2);
  }
}

// ── 拖拽删除：琴键底部中心圆形 × 按钮 ──
.key-clear-icon {
  position: absolute;
  transform: translateX(-50%);
  z-index: 6;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(255, 236, 186, 0.72);
  border-radius: 50%;
  background: #8b4a18;
  color: #fff3d4;
  cursor: grab;
  box-shadow: 0 1px 4px rgba(37, 18, 4, 0.42);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
  &:hover {
    transform: translateX(-50%) scale(1.06);
    background: #b46422;
    box-shadow: 0 3px 8px rgba(246, 183, 60, 0.35);
  }
  &:active {
    cursor: grabbing;
    transform: translateX(-50%) scale(0.96);
  }
}
.key-clear-glyph {
  font-size: 16px;
  font-weight: 800;
  line-height: 1;
  pointer-events: none;
}
.sticker-svg {
  width: 15px;
  height: 15px;
  path {
    fill: #f6b73c;
    stroke: #9a6b1a;
    stroke-width: 1.2;
    stroke-linejoin: round;
  }
  path:nth-child(2) {
    fill: #e09a2a;
  }
}

// ── 拖拽目标垃圾桶（弹窗右上角固定）+ callout 标签 ──
// pointer-events:none：hit-test 用 getBoundingClientRect，不靠 pointer 事件，免遮挡幽灵移动。
// 定位在 piano-keyboard 右上角（popout 内 title 正下方右侧）：拖拽全程光标留在 popout 内，
// 不触发 popout 的 pointerleave -> 不会中途关闭卸载组件而中断拖拽。
.trash-dropzone {
  position: absolute;
  right: 0;
  top: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  pointer-events: none;
}
.trash-icon {
  display: block;
  .trash-svg {
    width: 30px;
    height: 30px;
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45));
    .trash-lid {
      transform-box: fill-box;
      transform-origin: 50% 100%;
      transition: transform 220ms ease;
      rect {
        fill: #6b5436;
      }
    }
    .trash-body {
      transform-box: fill-box;
      transform-origin: 50% 100%;
      transition: transform 220ms ease;
      path {
        fill: #8a7355;
        stroke: #4a3a1a;
        stroke-width: 1;
        stroke-linejoin: round;
      }
    }
    .trash-content {
      stroke: #f6e8c8;
      stroke-width: 1.4;
      stroke-linecap: round;
      transition:
        transform 220ms ease,
        opacity 220ms ease;
    }
  }
}
// 命中预览：主题色高亮。
.trash-dropzone.is-over .trash-svg {
  filter: drop-shadow(0 0 8px rgba(246, 183, 60, 0.9));
}
// 释放命中：倒掉动画（盖子翻开 + 桶身倾斜 + 内容倒出）。
.trash-icon.is-dumping .trash-svg {
  .trash-lid {
    transform: rotate(-60deg);
  }
  .trash-body {
    transform: rotate(-22deg);
  }
  .trash-content {
    transform: translateY(10px);
    opacity: 0;
  }
}
.trash-callout {
  position: relative;
  padding: 4px 8px;
  border-radius: 6px;
  background: #fff;
  color: #4a3a1a;
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  // 上三角指向垃圾桶（callout 在 icon 下方，三角朝上）。
  &::before {
    content: '';
    position: absolute;
    top: -5px;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-bottom-color: #fff;
  }
}
.trash-dropzone.is-over .trash-callout {
  background: #f6b73c;
  color: #2a1a05;
  &::before {
    border-bottom-color: #f6b73c;
  }
}

// ── 拖拽幽灵（fixed 跟随光标，只显标签贴纸） ──
.clear-ghost {
  position: fixed;
  z-index: 1000;
  transform: translate(-50%, -50%);
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  .ghost-sticker {
    width: 26px;
    height: 26px;
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.45));
  }
}
</style>
