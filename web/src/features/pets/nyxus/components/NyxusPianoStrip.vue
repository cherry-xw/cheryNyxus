<script setup lang="ts">
/**
 * NyxusPianoStrip：对话框底部边框线「外挂」的标准钢琴键盘。
 * 挂在 .dialog-panel.is-nyxus-panel 之外（position:absolute; top:100%），如琴键从琴体下沿伸出。
 * 琴键数量严格等于 Nyxus 根历史会话数量；会话按 createdAt 升序从左到右占连续键。
 * 运行中且有 pending 审批 → 该键闪烁（临近过期加速）；选中键高亮。
 * 静音与删除目标固定在钢琴面板右上角；删除拖拽幽灵 Teleport 到 body，使用视口坐标跟随。
 */
import { computed, onBeforeUnmount, onMounted, onScopeDispose, ref, watch } from 'vue'
import { ElTooltip } from 'element-plus'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'
import type { ApprovalState } from '@/stores/agents'
import type { ChatSummary } from '@/services/agentApi'
import {
  BASE_MIDI,
  WHITE_W,
  isBlackKey,
  keyboardKeyCount,
  layoutPianoKeys,
  sessionPianoKeyCount,
  type PianoKeyGeom,
} from '../composables/pianoNotes'
import { usePianoAudio } from '../composables/usePianoAudio'
import { useDragPan } from '../composables/useDragPan'
import { useNow } from '@/features/pets/composables/useNow'
import { remainingSecOf, flashPeriodOf, isExpired } from '@/features/pets/utils/approvalTiming'

const emit = defineEmits<{
  select: [chatId: string]
  delete: [chatId: string]
  'interacting-change': [v: boolean]
}>()

const props = withDefaults(
  defineProps<{
    presetId?: string
    presetName?: string
    activeChatId?: string | null
  }>(),
  { presetName: CHERY_NYXUS_PRESET },
)

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const audio = usePianoAudio()
const now = useNow(250)

/** One key per root conversation in the selected preset workspace. */
const sessions = computed<ChatSummary[]>(() =>
  (agents.historyList ?? [])
    .filter(
      (c) =>
        !c.parentChatId &&
        (props.presetId ? c.presetId === props.presetId : c.preset === props.presetName),
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
)

const presetChats = computed<ChatSummary[]>(() =>
  (agents.historyList ?? []).filter((c) =>
    props.presetId ? c.presetId === props.presetId : c.preset === props.presetName,
  ),
)

function chatsInRoot(rootChatId: string): ChatSummary[] {
  const byId = new Map(presetChats.value.map((chat) => [chat.chatId, chat]))
  return presetChats.value.filter((chat) => {
    let current: ChatSummary | undefined = chat
    const seen = new Set<string>()
    while (current && !seen.has(current.chatId)) {
      if (current.chatId === rootChatId) return true
      seen.add(current.chatId)
      current = current.parentChatId ? byId.get(current.parentChatId) : undefined
    }
    return false
  })
}

/**
 * 渲染键数 = max(档位键数, 会话数)：档位按视口选 1/2/3 八度（12/24/36 键）作下限，
 * 会话多于档位则按会话数占键。viewportW 由 ResizeObserver 实时测。
 * 铺满判定：渲染白键 × 32 ≤ 视口 -> 白键按比例均分填满视口（消除右侧空隙，单键宽随档位
 * 接近 32px 钢琴规制）；会话多于档位致轨宽超出视口 -> 固定 32px + 拖拽平移。
 */
const viewportW = ref(0)
const renderCount = computed(() =>
  Math.max(keyboardKeyCount(viewportW.value), sessionPianoKeyCount(sessions.value.length)),
)
const whiteCount = computed(() => {
  let n = 0
  for (let i = 0; i < renderCount.value; i++) if (!isBlackKey(BASE_MIDI + i)) n++
  return n
})
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
const keyboardRef = ref<HTMLElement | null>(null)
const keyboardW = ref(0)
const drag = useDragPan({
  viewportWidth: () => viewportRef.value?.clientWidth ?? 0,
  contentWidth: () => layout.value.trackWidth,
})

// 视口宽实时测量 -> 驱动键盘档位选择（1/2/3 八度）。
let pianoRO: ResizeObserver | null = null
onMounted(() => {
  const el = viewportRef.value
  if (!el) return
  viewportW.value = el.clientWidth
  keyboardW.value = keyboardRef.value?.clientWidth ?? 0
  pianoRO = new ResizeObserver(() => {
    viewportW.value = el.clientWidth
    keyboardW.value = keyboardRef.value?.clientWidth ?? 0
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
  attentionCount: number
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
        attentionCount: 0,
        deletable: false,
      }
    }
    const rootChats = chatsInRoot(summary.chatId)
    const session = chatSessions.sessionsById[summary.chatId]
    const hydrated = rootChats
      .map((chat) => chatSessions.sessionsById[chat.chatId]?.interaction.approval)
      .find((item): item is ApprovalState => !!item)
    const listed = rootChats.map((chat) => chat.pendingApproval).find((item) => !!item) ?? undefined
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
    const attentionCount = rootChats.reduce((count, chat) => {
      const hydratedChat = chatSessions.sessionsById[chat.chatId]
      const questionCount = hydratedChat
        ? hydratedChat.interaction.questionBatches.reduce(
            (sum, batch) =>
              sum + batch.questions.filter((question) => question.localStatus === 'pending').length,
            0,
          )
        : (chat.pendingQuestionCount ?? 0)
      const approvalCount = hydratedChat
        ? hydratedChat.interaction.approval
          ? 1
          : 0
        : chat.pendingApproval
          ? 1
          : 0
      return count + questionCount + approvalCount
    }, 0)
    const blink = running && !!approval && !isExpired(approval, now.value)
    const prev = summary.preview?.trim()
    return {
      geom: g,
      hasData: true,
      chatId: summary.chatId,
      selected: summary.chatId === (props.activeChatId ?? agents.activeNyxusChatId),
      blink,
      flashPeriod: approval ? flashPeriodOf(approval, now.value) : 5,
      time: formatTime(summary.createdAt),
      tip: `${g.name} · MIDI ${g.midi} · ${prev || '无消息'}${attentionCount ? ` · ${attentionCount} 项待处理` : ''}`,
      approval,
      attentionCount,
      deletable: !running && attentionCount === 0,
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

// ── 拖拽删除（二次确认 = 拖到顶部垃圾桶释放，不开弹窗） ──
// hover 可删键 -> 键顶部显清除 icon；垃圾桶滑到该键附近顶行；按住 icon 拖拽 ->
// 释放在垃圾桶上 -> emit delete。运行中/pending 审批键不可删（deletable=false，icon 不显）。
const hoveredIdx = ref<number | null>(null)
const hoveredKeyView = computed<KeyView | null>(() =>
  hoveredIdx.value != null ? (keyViews.value[hoveredIdx.value] ?? null) : null,
)
/** 清除按钮中心与 hover 键中心对齐（相对 piano-stage 左缘）。 */
const clearIconLeft = computed(() => {
  const v = hoveredKeyView.value
  if (!v) return 0
  // 绝对定位相对 .piano-stage；琴键轨在其左右 6px 内边距之后。
  return 6 + v.geom.left + drag.offsetX.value + v.geom.width / 2
})
/** 清除按钮贴琴键顶部：黑白键顶部对齐 y=0，黑->白键移动不换位，避免从底部拉拽时跨键换位点不到。 */
const clearIconTop = 0

const trashRef = ref<HTMLElement | null>(null)
const clearDrag = ref<{ chatId: string; centerX: number } | null>(null)
const ghostX = ref(0)
const ghostY = ref(0)
const overTrash = ref(false)
const dumping = ref(false)
const ghostFlying = ref(false)
const deletingChatId = ref<string | null>(null)
/**
 * 自适应垃圾桶：interact（hover 可删键 / 拖拽）时滑到焦点键附近顶行，idle 回右上角。
 * 焦点 = 拖拽源键（centerX 在 onClearDown 冻结）否则 hover 键中心；x clamp 到面板内。
 */
const TRASH_SIZE = 24
const TRASH_MARGIN = 4
/** 垃圾桶锚点到焦点键右上的水平偏移：不贴键正上方，留一段拖拽动作空间，clamp 后不会太远。 */
const TRASH_RIGHT_OFFSET = 48
/** 右上角预留宽：头部右侧 padding 2 + 静音键 24 + gap 4 + 垃圾桶 24 = 54。 */
const IDLE_RIGHT_RESERVE = 54
const focusCenterX = computed<number>(() => {
  if (clearDrag.value) return clearDrag.value.centerX
  const v = hoveredKeyView.value
  if (!v) return Number.NaN
  return 6 + v.geom.left + drag.offsetX.value + v.geom.width / 2
})
const trashStyle = computed<Record<string, string>>(() => {
  const w = keyboardW.value
  const size = TRASH_SIZE
  const cx = focusCenterX.value
  if (!Number.isFinite(cx) || w <= 0) {
    return { left: `${Math.max(w - IDLE_RIGHT_RESERVE, TRASH_MARGIN)}px`, top: '2px' }
  }
  // 锚定焦点键右上方：向右偏移一段让拖拽动作自然；clamp 保证右缘键仍贴右缘不越界。
  const tx = cx + TRASH_RIGHT_OFFSET
  const left = Math.min(
    Math.max(tx - size / 2, TRASH_MARGIN),
    Math.max(w - size - TRASH_MARGIN, TRASH_MARGIN),
  )
  return { left: `${left}px`, top: '2px' }
})
/** 删除交互进行中（hover 可删键 / 拖拽 / ghost 飞入 / 倒掉动画）：通知父级锁定 popout 不关闭。 */
const interacting = computed(
  () =>
    !!clearDrag.value ||
    dumping.value ||
    ghostFlying.value ||
    !!hoveredKeyView.value?.deletable,
)
watch(interacting, (v) => emit('interacting-change', v))
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
  overTrash.value = false
  window.removeEventListener('pointermove', onClearMove)
  window.removeEventListener('pointerup', onClearUp)
  window.removeEventListener('pointercancel', onClearUp)
  if (hit && chatId) {
    // 释放命中：ghost 飞向垃圾桶中心缩小消失 -> 被删键淡出 -> 倒掉动画 -> 删除数据。
    deletingChatId.value = chatId
    const r = trashRef.value?.getBoundingClientRect()
    if (r) {
      ghostFlying.value = true
      ghostX.value = r.left + r.width / 2
      ghostY.value = r.top + r.height / 2
    }
    dumpTimer = setTimeout(() => {
      ghostFlying.value = false
      clearDrag.value = null
      dumping.value = true
      dumpTimer = setTimeout(() => {
        dumping.value = false
        deletingChatId.value = null
        dumpTimer = undefined
        emit('delete', chatId)
      }, 450)
    }, 250)
  } else {
    clearDrag.value = null
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
  clearDrag.value = {
    chatId: v.chatId,
    centerX: 6 + v.geom.left + drag.offsetX.value + v.geom.width / 2,
  }
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
  ghostFlying.value = false
  deletingChatId.value = null
  if (clearPointerId === -1) return
  clearPointerId = -1
  clearDrag.value = null
  window.removeEventListener('pointermove', onClearMove)
  window.removeEventListener('pointerup', onClearUp)
  window.removeEventListener('pointercancel', onClearUp)
})
</script>

<template>
  <div ref="keyboardRef" class="piano-keyboard">
    <header class="piano-panel-head">
      <button
        type="button"
        class="piano-panel-action"
        :class="{ 'is-active': audio.muted.value }"
        :aria-label="audio.muted.value ? '开启琴键音' : '静音琴键音'"
        :title="audio.muted.value ? '开启琴键音' : '静音琴键音'"
        :aria-pressed="audio.muted.value"
        @click="audio.toggleMute"
      >
        <span aria-hidden="true">{{ audio.muted.value ? '∅' : '♪' }}</span>
      </button>
      <span class="piano-panel-title">{{ (presetName || 'PRESET').toUpperCase() }} · SESSION KEYS</span>
    </header>
    <!-- 自适应垃圾桶：interact 时滑到焦点键附近顶行，idle 回右上角。 -->
    <span
      ref="trashRef"
      class="piano-trash-target"
      :class="{ 'is-ready': clearDrag || hoveredKeyView?.deletable, 'is-over': overTrash, 'is-dumping': dumping }"
      :style="trashStyle"
      :title="clearDrag ? '松开以删除该会话' : '将琴键顶部的清除按钮拖到这里'"
      aria-label="删除会话拖放目标"
    >
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
    <div class="piano-stage">
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
            placement="bottom"
            :show-after="150"
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
                  'is-drag-source': v.chatId === clearDrag?.chatId,
                  'is-deleting': v.chatId === deletingChatId,
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
              <span v-if="v.attentionCount" class="key-attention-count">{{ v.attentionCount }}</span>
            </button>
          </ElTooltip>
        </div>
        <div v-else class="piano-empty">暂无历史会话</div>
      </div>
      <!-- 清除按钮：hover 可删键时在其顶部中心显示，按住拖到上方垃圾桶才删除。 -->
      <button
        v-if="hoveredKeyView?.deletable"
        type="button"
        class="key-clear-icon"
        :style="{ left: clearIconLeft + 'px', top: clearIconTop + 'px' }"
        title="拖到上方垃圾桶删除该会话"
        @pointerdown="onClearDown($event, hoveredKeyView!)"
        @pointerenter="onIconEnter"
        @pointerleave="onIconLeave($event)"
      >
        <span class="key-clear-glyph" aria-hidden="true">×</span>
      </button>
    </div>
    <Teleport to="body">
      <!-- 脱离 transformed popout，fixed 坐标与 PointerEvent.clientX/Y 使用同一视口参照。 -->
      <div
        v-if="clearDrag"
        class="clear-ghost"
        :class="{ 'is-flying': ghostFlying }"
        :style="{ left: ghostX + 'px', top: ghostY + 'px' }"
      >
        <svg class="ghost-msg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5 H20 V15 H10 L6 19 V15 H4 Z" />
          <line x1="7" y1="9" x2="17" y2="9" />
          <line x1="7" y1="12" x2="14" y2="12" />
        </svg>
      </div>
    </Teleport>
  </div>
</template>

<style scoped lang="less">
.piano-keyboard {
  position: relative;
  z-index: 5;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 146px;
  box-sizing: border-box;
}
.piano-panel-head {
  flex: 0 0 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  padding: 0 2px 0 5px;
  box-sizing: border-box;
}
.piano-panel-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: rgba(255, 230, 177, 0.76);
  font:
    700 8px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  letter-spacing: 0.13em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.piano-panel-action,
.piano-trash-target {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  border: 0;
  border-radius: 7px;
  color: rgba(255, 232, 187, 0.62);
  background: rgba(45, 24, 8, 0.26);
}
.piano-panel-action {
  padding: 0;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease,
    background-color 120ms ease;
  &:active {
    transform: scale(0.97);
  }
  &.is-active {
    color: #ffe4a6;
    background: rgba(111, 65, 16, 0.46);
  }
}
.piano-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  padding: 0 6px 6px;
  box-sizing: border-box;
}

.piano-viewport {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
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
  &.is-deleting {
    transform: scale(0.6) translateY(10px);
    opacity: 0;
    transition: transform 300ms ease, opacity 300ms ease;
  }
  &.is-drag-source {
    filter: brightness(1.08) saturate(1.18);
    outline: 2px solid rgba(246, 183, 60, 0.94);
    outline-offset: -2px;
    box-shadow:
      0 0 0 2px rgba(246, 183, 60, 0.22),
      0 0 12px rgba(246, 183, 60, 0.5),
      inset 0 0 10px rgba(246, 183, 60, 0.18);
    transform: translateY(-2px);
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
.key-attention-count {
  position: absolute;
  top: 5px;
  right: 3px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  color: #fff;
  background: #d85b27;
  box-shadow: 0 1px 4px rgba(75, 28, 5, 0.38);
  font: 800 8px/13px ui-monospace, Menlo, monospace;
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

// ── 拖拽删除：琴键顶部中心圆形 × 按钮 ──
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
  animation: nx-clear-pulse 1.8s ease-in-out infinite;
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
@keyframes nx-clear-pulse {
  0%,
  100% {
    filter: drop-shadow(0 0 0 rgba(246, 183, 60, 0));
  }
  50% {
    filter: drop-shadow(0 0 6px rgba(246, 183, 60, 0.7));
  }
}
.key-clear-glyph {
  font-size: 16px;
  font-weight: 800;
  line-height: 1;
  pointer-events: none;
}
.piano-trash-target {
  position: absolute;
  top: 2px;
  z-index: 30;
  pointer-events: none;
  transition:
    left 200ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms ease,
    background-color 140ms ease;
  .trash-svg {
    width: 16px;
    height: 16px;
    opacity: 0.58;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
    transition:
      transform 180ms cubic-bezier(0.23, 1, 0.32, 1),
      filter 180ms ease,
      opacity 140ms ease;
  }
  .trash-lid {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    transition: transform 220ms ease;
    rect {
      fill: currentcolor;
    }
  }
  .trash-body {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    transition: transform 220ms ease;
    path {
      fill: currentcolor;
      stroke: rgba(57, 31, 8, 0.7);
      stroke-width: 1;
      stroke-linejoin: round;
    }
  }
  .trash-content {
    stroke: rgba(69, 38, 10, 0.82);
    stroke-width: 1.4;
    stroke-linecap: round;
    transition:
      transform 220ms ease,
      opacity 220ms ease;
  }
  &.is-ready {
    color: #ffe4a6;
    background: rgba(111, 65, 16, 0.52);
    .trash-svg {
      opacity: 1;
      transform: scale(1.08);
    }
  }
  &.is-over {
    color: #fff0bd;
    background: rgba(163, 91, 18, 0.72);
    .trash-svg {
      opacity: 1;
      filter: drop-shadow(0 0 7px rgba(246, 183, 60, 0.9));
      transform: scale(1.16);
    }
  }
}
// 释放命中：倒掉动画（盖子弹性翻开 + 桶身下沉倾斜 + 内容粒子化散落 + 回弹）。
.piano-trash-target.is-dumping .trash-svg {
  .trash-lid {
    transform: rotate(-74deg);
    transition: transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .trash-body {
    transform: rotate(-14deg) translateY(2px);
    transition: transform 380ms ease;
  }
  .trash-content {
    opacity: 0;
    transition: transform 300ms ease, opacity 300ms ease;
  }
  .trash-content:nth-child(2) {
    transform: translateY(13px) translateX(-3px) rotate(-14deg);
    transition-delay: 0ms;
  }
  .trash-content:nth-child(3) {
    transform: translateY(14px) rotate(8deg);
    transition-delay: 70ms;
  }
  .trash-content:nth-child(4) {
    transform: translateY(13px) translateX(3px) rotate(16deg);
    transition-delay: 140ms;
  }
}

// ── 拖拽幽灵（fixed 跟随光标，会话消息气泡 icon） ──
.clear-ghost {
  position: fixed;
  z-index: 1000;
  transform: translate(-50%, -50%);
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  &.is-flying {
    transition: left 250ms cubic-bezier(0.4, 0, 0.6, 1), top 250ms cubic-bezier(0.4, 0, 0.6, 1);
  }
  .ghost-msg {
    width: 26px;
    height: 26px;
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.45));
    animation: nx-ghost-wobble 1.4s ease-in-out infinite;
    path {
      fill: #f6b73c;
      stroke: #9a6b1a;
      stroke-width: 1.2;
      stroke-linejoin: round;
    }
    line {
      stroke: #5a3a0a;
      stroke-width: 1.6;
      stroke-linecap: round;
    }
  }
  &.is-flying .ghost-msg {
    animation: none;
    transform: scale(0.2);
    opacity: 0;
    transition: transform 250ms ease, opacity 250ms ease;
  }
}
@keyframes nx-ghost-wobble {
  0%,
  100% {
    transform: rotate(-8deg) scale(1);
  }
  50% {
    transform: rotate(8deg) scale(1.06);
  }
}
@media (prefers-reduced-motion: reduce) {
  .piano-key.is-drag-source {
    transform: none;
  }
  .key-clear-icon,
  .clear-ghost .ghost-msg {
    animation: none;
  }
}
</style>
