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
import { useNyxusHost } from '../application/host'
import { CHERY_NYXUS_PRESET } from '@/domain/pets/presets'
import type { ApprovalState } from '@/domain/chat/projectionTypes'
import type { ChatSummary } from '@/application/backend/public'
import {
  BASE_MIDI,
  WHITE_W,
  isBlackKey,
  isPianoRootSession,
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
  /** 无历史数据的空键被点击：请求清空并新建空白会话（仅渲染开始节点）。 */
  create: []
  'interacting-change': [v: boolean]
}>()

const props = withDefaults(
  defineProps<{
    presetId?: string
    presetName?: string
    activeChatId?: string | null
    /** 会话目录拉取中（WorkbenchDialog 连接就绪初始化传入）：无会话数据时显示加载占位。 */
    loading?: boolean
  }>(),
  { presetName: CHERY_NYXUS_PRESET },
)

const { agents, chats: chatSessions } = useNyxusHost()
const audio = usePianoAudio()
const now = useNow(250)

/**
 * 归属判定：会话属于该工作台预设 ⇔ 预设名或 presetId 命中其一。
 * 预设名总是存在（Nyxus 工作台以预设名'cheryNyxus'开窗，Pet 以 hashed presetId 开窗），
 * 而会话 metadata.presetId 统一存 hashed id（config ensurePresetIds 派生），故须双通道匹配。
 */
function belongsToPreset(c: ChatSummary): boolean {
  return c.preset === props.presetName || c.presetId === props.presetId
}

/**
 * 琴键只映射原生 root 会话（isPianoRootSession：`!parentChatId` 且 branchKind
 * 缺省或 'original'，剔 spawn 子角色与延续/解释分支）。被激活为主干的
 * continuation 也经工作台标题栏访问，不占琴键（约定见 docs/web/pet/rendering.md）。
 */
const sessions = computed<ChatSummary[]>(() =>
  (agents.historyList ?? [])
    .filter((c) => isPianoRootSession(c) && belongsToPreset(c))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
)

const presetChats = computed<ChatSummary[]>(() =>
  (agents.historyList ?? []).filter(
    (c) => c.preset === props.presetName || c.presetId === props.presetId,
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
  // 空键（无历史数据）：不复用旧树，请求父级清空并切到空白会话。
  else emit('create')
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
        <!-- 会话目录拉取中：琴键仍是空档位键，叠占位防误读为「无历史会话」。 -->
        <div v-if="loading && !sessions.length" class="piano-loading" aria-live="polite">
          会话加载中…
        </div>
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

<style scoped lang="less" src="./NyxusPianoStrip.styles.less"></style>
