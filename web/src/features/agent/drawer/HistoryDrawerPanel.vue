<script setup lang="ts">
/**
 * HistoryDrawerPanel：历史抽屉单面板（从 HistoryDrawer 拆出，CP4 栈化）。
 *
 * 由 HistoryDrawer 栈容器 v-for 渲染，每实例对应栈中一个 chatId：
 * - chatId 驱动 pet/layout/history 解析 + 历史载入（经 manager.loadHistory，预留缓存层）
 * - 群消息渲染（MessageBubble）+ 上下文用量条 + 宽度拖拽
 * - jumpToSpawn：group 模式本面板内滚动定位；direct 模式（子 chat 自身）push 主 chat 到栈顶
 * - 仅栈顶面板（isTop）显示 ✕；下层同宽 + DOM 顺序在后，被完全遮盖不可交互
 *
 * 虚拟列表：使用通用 VirtualScroll。
 * - 按稳定消息 key 缓存离屏项的实测高度；动态高度变化会补偿视口锚点，避免快速滚动抖动。
 * - 长消息、思考折叠和媒体加载均由 ResizeObserver 重新量测。
 * 错误显性化（规则 12）：stream 不存在时显 loading 而非崩（getHistory ensureStream，理论不达）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from 'vue'
import { motion } from 'motion-v'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import type { HistoryItem } from '@/stores/agents'
import VirtualScroll from '@/components/VirtualScroll.vue'
import { dedupHistoryByMsgId } from '@/stores/agents/data/historyMerge'
import {
  reconcileAgentLoadingEntries,
  type AgentLoadingEntry,
} from '@/stores/agents/data/historyLoading'
import MessageBubble from '../chat/MessageBubble.vue'
import { useDrawerWidth } from './useDrawerWidth'
import { useSubPetResolution } from '../composables/useSubPetResolution'
import { useHistoryDrawerManager } from './useHistoryDrawerManager'
import { breakdownSegments, fmtTokens, segmentThinkingNote } from '../toolbar/contextBreakdown'
import type { BreakdownKey } from '../toolbar/contextBreakdown'
import PromptSnapshotTip from './PromptSnapshotTip.vue'
import { agentApi } from '@/services/agentApi'
import type { GraphToolCall, PromptSnapshotTool, TimelineNode } from '@/services/agentApi'
import { useChatSessionData } from '@/stores/chats/useChatSessionData'

const MotionDiv = motion.div

/** 按消息内容估算未量测项的高度，量测完成后由 VirtualScroll 替换。 */
function estimateHeight(item: HistoryItem | undefined): number {
  if (!item) return 120
  const role = item.role
  if (role === 'user' || role === 'master') return 90
  const hasThinking = !!item.thinking && item.thinking.trim().length > 0
  const senseCount = item.senseCalls?.length ?? 0
  if (hasThinking && senseCount > 0) return 320
  if (hasThinking) return 220
  if (senseCount > 0) return 180
  return 130
}

/** 取前 N 字预览：折叠空白 + 去首尾 + 超长 ellipsis。空内容显占位串。供滚动条标记 title 用。 */
function previewOf(content: string | undefined, maxLen = 10): string {
  if (!content) return '(空)'
  const compact = content.replace(/\s+/g, ' ').trim()
  return compact.length > maxLen ? compact.slice(0, maxLen) + '…' : compact
}

/** minimap hover tooltip 预览：保留原文换行（多行消息分多行显示），折叠多余空白；空内容显占位串。 */
function previewTooltip(content: string | undefined): string {
  if (!content) return '(空)'
  // 保留 \n（多行消息分行显示），折叠空格/Tab，截 150 字符
  const compact = content.replace(/[ \t]+/g, ' ').trim()
  return compact.length > 150 ? compact.slice(0, 150) + '…' : compact
}

/** CanonicalSenseCall（后端 V2：arguments + status pending/accepted/rejected/completed）
 * → SenseCallRecord（渲染层：args + status running/done/error）。
 * 与 reducer.canonicalToChatMessage 的 senseCalls 映射同款，避免 SenseCallBox 读到空 args / '?' 状态。 */
function canonicalToolCallToSense(
  c: GraphToolCall,
): NonNullable<HistoryItem['senseCalls']>[number] {
  return {
    id: c.callId,
    name: c.name,
    args: c.arguments,
    result: c.result,
    status: c.status === 'rejected' ? 'error' : c.status === 'pending' ? 'running' : 'done',
  }
}

/** Root timeline node -> legacy bubble view. All identity/direction decisions
 * already came from the backend actor fields; this is presentation only. */
function rootNodeToHistory(node: TimelineNode): HistoryItem {
  const childId =
    node.actor.kind === 'agent' && node.actor.chatId !== node.rootChatId
      ? node.actor.chatId
      : node.target?.kind === 'agent' && node.target.chatId !== node.rootChatId
        ? node.target.chatId
        : undefined
  const role: HistoryItem['role'] =
    node.actor.kind === 'user'
      ? 'user'
      : node.direction === 'parent-to-child'
        ? 'master'
        : node.direction === 'child-to-parent' || (node.actor.kind === 'agent' && childId)
          ? 'role'
          : 'assistant'
  return {
    role,
    content: node.content,
    ...(node.thinking ? { thinking: node.thinking } : {}),
    ...(node.toolCalls?.length ? { senseCalls: node.toolCalls.map(canonicalToolCallToSense) } : {}),
    createdAt: node.createdAt,
    msgId: node.id,
    agentChatId: node.sourceChatId,
    ...(childId ? { subPetChatId: childId } : {}),
    ...(node.target?.kind === 'agent' && node.target.chatId !== node.rootChatId
      ? { callerSubPetChatId: node.actor.kind === 'agent' ? node.actor.chatId : node.rootChatId }
      : {}),
    ...(node.kind === 'return' ? { mergedView: 'child-to-master' as const } : {}),
    ...(node.actor.kind === 'agent' && node.actor.roleType ? { petName: node.actor.roleType } : {}),
    ...(node.causationId ? { spawnSenseCallId: node.causationId } : {}),
    ...(node.termination ? { termination: node.termination } : {}),
  }
}

// minimap tooltip 内容样式：el-popper 渲染到 body 外，scoped 样式不命中，用 inline 注入。
const previewTooltipStyle: CSSProperties = {
  maxWidth: '320px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  lineHeight: 1.45,
  fontSize: '11.5px',
}

const props = defineProps<{
  /** 本面板要展示的 chat。 */
  chatId: string
  /** 是否栈顶（唯一可交互层；仅栈顶显 ✕）。 */
  isTop: boolean
  /** 层叠 z-index（280 + N×10 + 1，确保栈顶在上）。 */
  zIndex: number
}>()

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const manager = useHistoryDrawerManager()
const sessionData = useChatSessionData(() => props.chatId)

const pet = computed(() => agents.pets.find((p) => p.chatId === props.chatId))
const chatPetName = computed(() => pet.value?.name ?? '')

// 布局：子 chat（ghost 自身面板，有 parentChatId）→ direct（master 右/ghost 左 1:1）；
//        主 chat → group（群聊双头像样式）。
const layout = computed<'group' | 'direct'>(() => (pet.value?.parentChatId ? 'direct' : 'group'))
const parentPet = computed(() =>
  pet.value?.parentChatId
    ? agents.pets.find((p) => p.chatId === pet.value!.parentChatId)
    : undefined,
)
const masterPetName = computed(() =>
  layout.value === 'direct' ? (parentPet.value?.name ?? '') : chatPetName.value,
)

const history = computed<HistoryItem[]>(() => {
  // V2 canonical timeline is already assembled by the backend. The only local
  // projection is layout (root + descendants) and transient session-plane rows.
  const result =
    layout.value === 'group'
      ? (chatSessions.rootTimeline(props.chatId, 'conversation')?.nodes ?? [])
          .filter((node) => node.visibility === 'conversation' || !!node.termination)
          .map(rootNodeToHistory)
      : sessionData.ownTimeline.value

  const transient: HistoryItem[] = []
  if (layout.value === 'group') {
    const rootState = chatSessions.rootTimelineStates[props.chatId]
    for (const input of rootState?.pendingInputs ?? []) {
      if (input.state === 'consumed' || input.state === 'cancelled' || input.state === 'rejected')
        continue
      transient.push({
        role: 'user',
        content: input.content,
        createdAt: input.acceptedAt ?? input.createdAt ?? Date.now(),
        msgId: input.messageId ?? `pending:${input.inputId}`,
        agentChatId: input.chatId ?? props.chatId,
      })
    }
    for (const turn of rootState?.activeTurns ?? []) {
      transient.push({
        role: 'assistant',
        content: turn.content,
        thinking: turn.thinking || undefined,
        createdAt: turn.createdAt ?? Date.now(),
        msgId: turn.messageId,
        agentChatId: turn.chatId ?? props.chatId,
      })
    }
  } else {
    const session = chatSessions.sessionsById[props.chatId]
    for (const input of session?.pendingInputs ?? []) {
      if (input.state === 'consumed' || input.state === 'cancelled' || input.state === 'rejected')
        continue
      transient.push({
        role: 'user',
        content: input.content,
        createdAt: input.acceptedAt ?? input.createdAt ?? Date.now(),
        msgId: input.messageId ?? `pending:${input.inputId}`,
        agentChatId: props.chatId,
      })
    }
    for (const turn of session?.activeTurns ?? []) {
      transient.push({
        role: 'assistant',
        content: turn.content,
        thinking: turn.thinking || undefined,
        createdAt: turn.createdAt ?? Date.now(),
        msgId: turn.messageId,
        agentChatId: props.chatId,
      })
    }
  }
  const canonicalIds = new Set(result.map((item) => item.msgId).filter(Boolean))
  const merged = dedupHistoryByMsgId(
    [...result, ...transient.filter((item) => !canonicalIds.has(item.msgId))].sort(
      (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
    ),
  )
  // 全局折叠子 agent 消息（role='role'/'subagent'）：仅作用于主 chat 合并视图（group）。
  // 子 agent 数据仍可经主 pet 消息内 spawn_role sense call 的「详情」下钻查看；
  // 下钻打开的子 chat 自身抽屉（direct layout）必须照常显示，不受折叠开关影响。
  return agents.collapseSubagent && layout.value === 'group'
    ? merged.filter((item) => item.role !== 'role' && item.role !== 'subagent')
    : merged
})
const loaded = computed<boolean>(() => sessionData.loaded.value)

// 仅人类用户消息（role === "user" 唯一标识；child-to-master 合并项底层是 master/role，不算）
// 保留原 history 索引以便点击直接复用 VirtualScroll.scrollToIndex，不再二次查找。
const userMarks = computed<Array<{ item: HistoryItem; idx: number }>>(() =>
  history.value.map((item, idx) => ({ item, idx })).filter(({ item }) => item.role === 'user'),
)

type VirtualScrollInstance = {
  scrollToEnd: (behavior?: ScrollBehavior) => void
  scrollToIndex: (
    index: number,
    options?: { align?: 'start' | 'center' | 'end'; behavior?: ScrollBehavior },
  ) => Promise<void>
  scrollToOffset: (offset: number, behavior?: ScrollBehavior) => void
  offsetOf: (index: number) => number
  /** 当前 scrollTop / 视口高度（Vue ref 形态，外部读 .value）。 */
  scrollTop: { value: number }
  viewportHeight: { value: number }
}

const virtualScrollRef = ref<VirtualScrollInstance | null>(null)

function getHistoryItemKey(item: HistoryItem, index: number): string {
  return item.msgId ?? `idx-${index}`
}

/** loading 头像三态背景框：master（主 agent）/ sub（子 agent 运行中）/ ghost（子 agent 已完成等待）。 */
function faceStateClass(entry: AgentLoadingEntry): 'is-master' | 'is-sub' | 'is-ghost' {
  if (entry.isMaster) return 'is-master'
  return entry.running ? 'is-sub' : 'is-ghost'
}

const loadingAgents = ref<AgentLoadingEntry[]>([])
const batchReloading = ref(false)
const showAgentLoading = computed(() => loadingAgents.value.length > 0 || batchReloading.value)
let batchChatId = ''
let settleTimer: ReturnType<typeof setTimeout> | null = null

const scopePets = computed(() => {
  const root = props.chatId
  if (layout.value === 'direct') return pet.value ? [pet.value] : []
  return agents.pets.filter((candidate) => {
    if (candidate.chatId === root) return true
    const seen = new Set<string>()
    let parent = candidate.parentChatId
    while (parent && !seen.has(parent)) {
      if (parent === root) return true
      seen.add(parent)
      parent = agents.pets.find((item) => item.chatId === parent)?.parentChatId
    }
    return false
  })
})

const workingScopePets = computed(() =>
  scopePets.value.filter(
    (candidate) => candidate.isWorking || agents.streams[candidate.chatId]?.isWorking,
  ),
)

function clearSettleTimer(): void {
  if (!settleTimer) return
  clearTimeout(settleTimer)
  settleTimer = null
}

function mergeLoadingAgents(): void {
  loadingAgents.value = reconcileAgentLoadingEntries(
    loadingAgents.value,
    workingScopePets.value.map((candidate) => {
      const name = candidate.name || candidate.agentType || candidate.chatId.slice(0, 8)
      return {
        chatId: candidate.chatId,
        name,
        // 三态统一显 name 首字母（英文大写）；主/子/ghost 区分改由背景框形状/边框承载。
        face: name.slice(0, 1).toUpperCase(),
        isMaster: candidate.isMaster,
      }
    }),
  )
}

function scheduleBatchReload(): void {
  if (settleTimer || loadingAgents.value.length === 0) return
  settleTimer = setTimeout(() => {
    settleTimer = null
    if (workingScopePets.value.length > 0 || props.chatId !== batchChatId) return
    batchReloading.value = true
    void manager
      .loadHistory(props.chatId)
      .catch((error) => console.error('[HistoryDrawer] batch history reload failed:', error))
      .finally(() => {
        if (workingScopePets.value.length === 0 && props.chatId === batchChatId) {
          loadingAgents.value = []
        }
        batchReloading.value = false
      })
  }, 300)
}

watch(
  [() => props.chatId, workingScopePets],
  ([chatId, working], [previousChatId] = ['', []]) => {
    if (!chatId) return
    if (chatId !== previousChatId || chatId !== batchChatId) {
      clearSettleTimer()
      loadingAgents.value = []
      batchReloading.value = false
      batchChatId = chatId
      // V2 session subscription is required even while a run is active so
      // turn.delta and timeline.patch are visible immediately.
      void manager
        .loadHistory(chatId)
        .catch((error) => console.error('[HistoryDrawer] V2 session open failed:', error))
    }
    if (working.length > 0) {
      clearSettleTimer()
      mergeLoadingAgents()
      return
    }
    if (loadingAgents.value.length > 0) {
      mergeLoadingAgents()
      scheduleBatchReload()
    }
  },
  { immediate: true },
)

onBeforeUnmount(clearSettleTimer)
onBeforeUnmount(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer)
})

function scrollToBottom(): void {
  void nextTick(() => virtualScrollRef.value?.scrollToEnd('auto'))
}

/** 滚动顶部 / 底部按钮（smooth）。走 scrollToIndex 复用其迭代收敛循环：
 *  动态高度虚拟列表里，scrollToEnd/scrollToOffset 一次性 smooth 滚到底/顶时，滚动过程中新进入
 *  视口的项被 ResizeObserver 量测 → flushMeasurements 的 anchorAdjustment 改写 scrollTop，
 *  打断 smooth 动画并使 scrollHeight 偏移，停不在真顶/真底。scrollToIndex 先多次 auto 跳触
 *  发量测、offsets 收敛后末次 smooth 收尾，精确落位。 */
function scrollToTopSmooth(): void {
  void virtualScrollRef.value?.scrollToIndex(0, { align: 'start', behavior: 'smooth' })
}

function scrollToBottomSmooth(): void {
  const last = history.value.length - 1
  if (last < 0) return
  void virtualScrollRef.value?.scrollToIndex(last, { align: 'end', behavior: 'smooth' })
}

/** 把 idx 项对齐到视口（start 顶部 / center 中部 / end 底部）。
 *  - jump-to-sensecall 用中心对齐 + smooth：柔和落位，避免硬切
 *  - scrollToBottom 仍走 scrollTop 直接赋值（聊天累积即时跟随更顺手）
 *  - 滚动边界由 VirtualScroll 统一处理。 */
function scrollToItem(idx: number, align: 'start' | 'center' | 'end'): void {
  void virtualScrollRef.value?.scrollToIndex(idx, { align, behavior: 'smooth' })
}

// 历史长度变化（流式累积）→ 滚到底
watch(() => history.value.length, scrollToBottom)
// loaded 切 true（首批 staged 回放完成）→ 滚到底
watch(loaded, (v) => {
  if (v) scrollToBottom()
})

// 宽度拖拽 + 持久化（localStorage，所有面板共享同一 key → 同宽）
const { panelStyle, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp } = useDrawerWidth()

// 合并宽度变量 + 层叠 z-index
const panelFullStyle = computed<Record<string, string>>(() => ({
  ...panelStyle.value,
  zIndex: String(props.zIndex),
}))

const {
  subPetName,
  subPetFace,
  subPetType,
  callerPetFace,
  callerPetName,
  callerIsMaster,
  isLastSubReply,
} = useSubPetResolution(history)

// F：smooth scroll 到指定 sense call 框（被唤起 agent 头像点击跳转用）
function scrollToSenseCall(senseCallId: string): void {
  const idx = history.value.findIndex((item) =>
    item.senseCalls?.some((sc) => sc.id === senseCallId),
  )
  if (idx < 0) return
  scrollToItem(idx, 'center')
}

// F：MessageBubble @jump-to-spawn handler
function onJumpToSpawn(payload: { senseCallId: string }): void {
  const { senseCallId } = payload
  if (!senseCallId) return
  // 当前面板是主 chat 合并视图 → 直接滚到对应 sense call 框
  if (layout.value === 'group') {
    scrollToSenseCall(senseCallId)
    return
  }
  // 当前面板是子 chat 自身（direct）→ push 主 chat 到栈顶（覆盖本面板）+ 待滚
  const subPet = agents.pets.find((p) => p.chatId === props.chatId)
  const parentChatId = subPet?.parentChatId
  if (parentChatId) {
    manager.drillChild(parentChatId)
    agents.pendingScrollSenseCallId = senseCallId
  }
}

// F：rail 点击把 idx 项对齐到视窗顶部（顶/底按钮不复用此：顶走 idx 0，底走 scrollToEnd）。
function onRailJump(idx: number): void {
  scrollToItem(idx, 'start')
}

// F：监听 store 跨面板滚动请求（push 主 chat 后，主面板挂载时 pending 已设 → immediate 触发滚动）
watch(
  () => agents.pendingScrollSenseCallId,
  (sid) => {
    if (sid && layout.value === 'group') {
      scrollToSenseCall(sid)
      // 一次性标记，滚动完成即清空，避免后续 history 变化误触发
      agents.pendingScrollSenseCallId = null
    }
  },
  { immediate: true },
)

const titleText = computed(() => {
  const name = chatPetName.value
  if (name) return `${name} 的历史`
  return `历史 · ${props.chatId.slice(0, 8)}…`
})

// chatId 复制反馈：点击复制 icon 后短暂显「已复制」（1.2s 后恢复）
const copied = ref(false)
let copyResetTimer: ReturnType<typeof setTimeout> | null = null
async function copyChatId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.chatId)
  } catch {
    // 降级：非 secure context 或权限拒绝时用 execCommand 兜底
    const ta = document.createElement('textarea')
    ta.value = props.chatId
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* 复制失败静默：icon 不切换，用户可重试 */
    }
    document.body.removeChild(ta)
  }
  copied.value = true
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copied.value = false
    copyResetTimer = null
  }, 1200)
}

/** contextUsage 颜色分级（与 ContextBar / SessionList 对齐：<50% 绿 / 50-80% 黄 / >80% 红）。 */
function usageClass(u: number): string {
  if (u >= 0.8) return 'usage-high'
  if (u >= 0.5) return 'usage-mid'
  return 'usage-low'
}

const usagePct = computed(() => (pet.value ? Math.round(pet.value.contextUsage * 100) : 0))
const usageDetail = computed(() => {
  if (!pet.value) return null
  const { contextUsed, contextTotal } = pet.value
  if (typeof contextUsed !== 'number' || typeof contextTotal !== 'number' || contextTotal <= 0)
    return null
  return { used: contextUsed, total: contextTotal }
})
/** 分段（breakdown 给出时用于分段彩色条 + 行内图例；缺省 → []，退化为单段 usage-fill）。
 *  - allSegs：全量，供图例（0 段灰色展示完整类目）。
 *  - usageSegs：过滤 token=0，供色块条（避免空类 min-width 显色噪声）。 */
const allSegs = computed(() => breakdownSegments(pet.value?.contextBreakdown))
const usageSegs = computed(() => allSegs.value.filter((s) => s.tokens > 0))

/** 行内图例短标签（区别于 ContextBreakdownTip 的全称标签，适配单行紧凑布局）。 */
const SHORT_LABELS: Record<BreakdownKey, string> = {
  system: '系统',
  userSystem: '用户',
  memory: '记忆',
  skills: '技能',
  tools: '工具',
  conversation: '对话',
}
function shortLabel(key: BreakdownKey): string {
  return SHORT_LABELS[key] ?? key
}

/** 图例标签文字色（加深版，区别于色块条鲜艳色：amber/green 原色在米白底对比不足）。 */
const LABEL_COLORS: Record<BreakdownKey, string> = {
  system: '#4338ca',
  userSystem: '#7e22ce',
  memory: '#be185d',
  skills: '#b45309',
  tools: '#047857',
  conversation: '#1d4ed8',
}
function labelColor(key: BreakdownKey): string {
  return LABEL_COLORS[key] ?? '#4338ca'
}

/** 图例中 0 token 段的灰色（标签 + tokens 统一降明度，区别于有量的彩色标签）。 */
const ZERO_COLOR = 'rgba(20, 22, 26, 0.38)'

/**
 * 系统提示词快照（顶部「上下文」hover 面板用）。
 * 懒加载：hover 顶部「上下文」标签才拉取 chat.promptSnapshot；按 chatId 缓存避免重复请求。
 * chatId 切换（栈层切换）时清空缓存重拉。
 */
const promptSnap = ref<{
  systemPrompt: string
  tools: PromptSnapshotTool[]
  status: 'idle' | 'loading' | 'error' | 'loaded'
  error?: string
} | null>(null)
let promptSnapChatId = ''

async function loadPromptSnapshot(chatId: string): Promise<void> {
  // 同 chat 已加载或加载中 → 不重复请求
  if (promptSnapChatId === chatId && promptSnap.value && promptSnap.value.status !== 'error') return
  promptSnapChatId = chatId
  promptSnap.value = { systemPrompt: '', tools: [], status: 'loading' }
  try {
    const res = await agentApi.promptSnapshot(chatId)
    // chatId 期间未切换才写入（避免竞态覆盖）
    if (promptSnapChatId === chatId) {
      promptSnap.value = {
        systemPrompt: res.systemPrompt,
        tools: res.tools,
        status: 'loaded',
      }
    }
  } catch (err) {
    if (promptSnapChatId === chatId) {
      promptSnap.value = {
        systemPrompt: '',
        tools: [],
        status: 'error',
        error: (err as Error).message,
      }
    }
  }
}

function onPromptSnapShow(): void {
  if (!props.chatId) return
  void loadPromptSnapshot(props.chatId)
}
</script>

<template>
  <MotionDiv
    class="drawer-panel"
    :style="panelFullStyle"
    :initial="{ x: '100%' }"
    :animate="{ x: 0 }"
    :transition="{ duration: 0.24, ease: 'easeOut' }"
    role="dialog"
    aria-modal="true"
    :aria-label="titleText"
  >
    <div
      class="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整宽度"
      @pointerdown="onHandlePointerDown"
      @pointermove="onHandlePointerMove"
      @pointerup="onHandlePointerUp"
    />
    <header class="drawer-head">
      <div class="title-block">
        <span class="title">{{ titleText }}</span>
        <button
          type="button"
          class="copy-id-btn"
          :class="{ copied }"
          :title="copied ? '已复制 chatId' : '点击复制 chatId'"
          @click="copyChatId"
        >
          <span class="copy-glyph">{{ copied ? '✓' : '📋' }}</span>
          <span class="copy-hint">{{ copied ? '已复制' : '点击复制 ID' }}</span>
        </button>
      </div>
      <div v-if="isTop" class="head-actions">
        <button
          v-if="layout === 'group'"
          type="button"
          class="collapse-sub-btn"
          :class="{ active: agents.collapseSubagent }"
          :aria-pressed="agents.collapseSubagent"
          :title="
            agents.collapseSubagent ? '当前已隐藏子 agent 消息，点击显示' : '隐藏所有子 agent 消息'
          "
          @click="agents.toggleCollapseSubagent()"
        >
          <span class="collapse-glyph">{{ agents.collapseSubagent ? '🙈' : '👥' }}</span>
        </button>
        <button type="button" class="close-btn" aria-label="Close" @click="manager.closeTop()">
          ✕
        </button>
      </div>
    </header>
    <div v-if="usageDetail" class="usage-bar-wrap" :class="usageClass(pet?.contextUsage ?? 0)">
      <div class="usage-bar-row">
        <el-popover
          trigger="hover"
          placement="bottom-start"
          :width="460"
          popper-class="prompt-snapshot-popper"
          :show-after="200"
          @show="onPromptSnapShow"
        >
          <template #reference>
            <span class="usage-label usage-label-hover">上下文</span>
          </template>
          <PromptSnapshotTip
            v-if="promptSnap"
            :system-prompt="promptSnap.systemPrompt"
            :tools="promptSnap.tools"
            :status="promptSnap.status"
            :error="promptSnap.error"
          />
        </el-popover>
        <div v-if="allSegs.length" class="usage-legend">
          <span
            v-for="seg in allSegs"
            :key="seg.key"
            class="legend-item"
            :class="{ 'is-zero': seg.tokens === 0 }"
          >
            <span
              class="legend-label"
              :style="{ color: seg.tokens > 0 ? labelColor(seg.key) : ZERO_COLOR }"
              >{{ shortLabel(seg.key) }}</span
            >
            <span v-if="segmentThinkingNote(seg)" class="legend-thinking">{{
              segmentThinkingNote(seg)
            }}</span>
            <span class="legend-tokens">{{ fmtTokens(seg.tokens) }}</span>
          </span>
        </div>
        <span class="usage-values">
          <span class="usage-used">{{ fmtTokens(usageDetail.used) }}</span>
          <span class="usage-sep">/</span>
          <span class="usage-total">{{ fmtTokens(usageDetail.total) }}</span>
          <span class="usage-pct">{{ usagePct }}%</span>
        </span>
      </div>
      <div class="usage-track">
        <template v-if="usageSegs.length">
          <div
            v-for="seg in usageSegs"
            :key="seg.key"
            class="usage-seg"
            :style="{ width: `${seg.pct}%`, background: seg.color }"
          />
        </template>
        <div v-else class="usage-fill" :style="{ width: `${Math.min(100, usagePct)}%` }" />
      </div>
    </div>

    <div class="drawer-body">
      <div v-if="!loaded && history.length === 0 && !showAgentLoading" class="loading-row">
        载入历史…
      </div>
      <div v-else-if="loaded && history.length === 0 && !showAgentLoading" class="empty-row">
        暂无历史
      </div>
      <VirtualScroll
        v-else-if="history.length > 0"
        ref="virtualScrollRef"
        class="history-list"
        :items="history"
        :item-key="getHistoryItemKey"
        :estimate-size="estimateHeight"
        :default-render-count="12"
      >
        <template #default="{ index }">
          <MessageBubble
            :item="history[index]!"
            :layout="layout"
            :master-pet-name="masterPetName"
            :sub-pet-name="subPetName(history[index]!)"
            :sub-pet-face="subPetFace(history[index]!)"
            :sub-pet-type="subPetType(history[index]!)"
            :caller-pet-face="callerPetFace(history[index]!)"
            :caller-pet-name="callerPetName(history[index]!)"
            :caller-is-master="callerIsMaster(history[index]!)"
            :show-master-badge="isLastSubReply(history[index]!)"
            @jump-to-spawn="onJumpToSpawn"
          />
        </template>

        <!-- 滚动条轨道上的 user 消息 minimap 标记：hover 预览 + 点击跳转（VirtualScroll 暴露 ratioOf/trackHeight） -->
        <template #scrollbar-mark="{ ratioOf, trackHeight }">
          <el-tooltip
            v-for="m in userMarks"
            :key="m.item.msgId ?? `idx-${m.idx}`"
            placement="left"
            :show-after="120"
          >
            <template #content>
              <div :style="previewTooltipStyle">{{ previewTooltip(m.item.content) }}</div>
            </template>
            <button
              type="button"
              class="scrollbar-mark"
              :style="{ top: `${ratioOf(m.idx) * trackHeight}px` }"
              :aria-label="`跳转到用户消息: ${previewOf(m.item.content, 30)}`"
              @pointerdown.stop
              @click.stop="onRailJump(m.idx)"
            />
          </el-tooltip>
        </template>
      </VirtualScroll>

      <!-- 滚动顶部 / 底部按钮：堆叠在 drawer-body 底部右侧（绝对定位，不挤压列表布局） -->
      <div v-if="history.length > 0" class="scroll-actions">
        <button
          type="button"
          class="scroll-btn"
          aria-label="滚动到顶部"
          title="滚动到顶部"
          @click="scrollToTopSmooth"
        >
          👆
        </button>
        <button
          type="button"
          class="scroll-btn"
          aria-label="滚动到底部"
          title="滚动到底部"
          @click="scrollToBottomSmooth"
        >
          👇
        </button>
      </div>
      <div v-if="showAgentLoading" class="agent-loading-list" aria-live="polite">
        <div v-for="entry in loadingAgents" :key="entry.chatId" class="agent-loading-row">
          <span class="agent-loading-face" :class="faceStateClass(entry)">{{ entry.face }}</span>
          <span class="agent-loading-copy">
            <b>{{ entry.name }}</b>
            <small>{{ entry.running ? '正在输入…' : '已完成，等待其他 Agent…' }}</small>
          </span>
          <span v-if="entry.running" class="typing-dots" aria-hidden="true"> <i /><i /><i /> </span>
          <span v-else class="agent-done" aria-hidden="true">✓</span>
        </div>
        <div v-if="batchReloading" class="batch-loading">正在整理全部 Agent 的完整内容…</div>
      </div>
    </div>
  </MotionDiv>
</template>

<style scoped lang="less">
@ink: #14161a;

// 面板绝对定位叠加（栈中多面板同位置 right:0，靠 z-index + DOM 顺序层叠）
.drawer-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: var(--drawer-w, clamp(320px, 40vw, 560px));
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fbf9f4;
  border-left: 1px solid rgba(36, 38, 45, 0.12);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.18);
}

.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  background: transparent;
  transition: background 0.15s;

  &:hover,
  &:active {
    background: rgba(36, 38, 45, 0.18);
  }
}

// 滚动条轨道上的 user 消息标记（minimap）：浅黄细线 + 大热区。
// button 本体透明 14px 高作 hover/click 热区（2px 线难点不准）；视觉线由 ::before 画。
// top 由父 inline-style 按 ratioOf(idx)*trackHeight 给定；margin-top 负值让热区垂直居中于 ratio 锚点。
.scrollbar-mark {
  position: absolute;
  left: 0;
  right: 0;
  height: 14px; // 热区高度（远大于视觉线，易 hover/click）
  margin-top: -7px; // 居中于 ratio 锚点
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.scrollbar-mark::before {
  content: '';
  position: absolute;
  left: 1px;
  right: 1px;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
  background: #fbbf24; // 浅黄（amber-400）默认
  border-radius: 1px;
  transition:
    background 0.12s ease,
    box-shadow 0.12s ease,
    height 0.12s ease;
}
.scrollbar-mark:hover::before,
.scrollbar-mark:focus-visible::before {
  background: #ca8a04; // 深黄（yellow-600）hover
  height: 3px; // hover 加粗增强反馈
  box-shadow: 0 0 4px rgba(202, 138, 4, 0.55);
}
.scrollbar-mark:focus-visible {
  outline: none;
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.1);
  background: rgba(255, 255, 255, 0.6);

  .title-block {
    display: flex;
    flex-direction: row;
    gap: 12px;
    min-width: 0;
  }

  .title {
    font-size: 13px;
    font-weight: 800;
    color: fade(@ink, 86%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  // 复制 chatId 按钮：替代原直接显示的长 chatId 文本。
  // 不显 ID 本体，仅用 icon + 「点击复制 ID」提示；复制成功短暂切「已复制 ✓」。
  .copy-id-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    border: 1px solid rgba(36, 38, 45, 0.12);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.6);
    color: fade(@ink, 50%);
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 10px;
    line-height: 1.4;
    cursor: pointer;
    align-self: flex-start;
    transition:
      background 120ms ease,
      color 120ms ease;

    &:hover {
      background: #ffffff;
      color: fade(@ink, 78%);
    }

    &.copied {
      border-color: rgba(34, 197, 94, 0.4);
      background: rgba(34, 197, 94, 0.1);
      color: #16a34a;
    }

    .copy-glyph {
      font-size: 11px;
    }
  }
}

// 头部右侧操作组（折叠子 agent + 关闭）
.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

// 折叠子 agent 消息切换按钮：active=已隐藏（高亮），非 active=正常显示
.collapse-sub-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 70%);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease;

  &:hover {
    background: #ffffff;
    color: fade(@ink, 88%);
  }

  &.active {
    border-color: rgba(246, 183, 60, 0.5);
    background: rgba(246, 183, 60, 0.16);
    color: #76500e;
  }

  .collapse-glyph {
    font-size: 12px;
  }
}

.close-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 70%);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;

  &:hover {
    background: #ffffff;
    color: fade(@ink, 88%);
  }
}

.drawer-body {
  flex: 1;
  padding: 12px 0 18px 14px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative; // 滚动按钮 .scroll-actions 绝对定位的参照
}

// 滚动顶部 / 底部按钮：堆叠在 drawer-body 右下角（绝对定位，不挤压列表布局）
.scroll-actions {
  position: absolute;
  right: 14px;
  bottom: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 2;
  pointer-events: none; // 容器不拦截，单独恢复给按钮
}

.scroll-btn {
  pointer-events: auto;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  color: fade(@ink, 78%);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  opacity: 0.3;
  transition: opacity 120ms ease;
  transition:
    background 120ms ease,
    transform 120ms ease;

  &:hover {
    background: #ffffff;
    color: fade(@ink, 92%);
    transform: translateY(-1px);
    opacity: 1;
  }

  &:active {
    transform: translateY(0);
  }
}

.loading-row,
.empty-row {
  padding: 16px 8px;
  text-align: center;
  color: fade(@ink, 48%);
  font-size: 12px;
  font-style: italic;
}

.history-list {
  flex: 1;
  min-height: 0;
  --virtual-scroll-gap: 10px;
}
.agent-loading-list {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 14px 0 0;
  padding-top: 8px;
  border-top: 1px dashed rgba(36, 38, 45, 0.13);
}
.agent-loading-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid rgba(99, 102, 241, 0.16);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.72);
}
.agent-loading-face {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  box-sizing: border-box;
}
/* master：实心圆（暖橙填充 + 白字），主 agent 视觉最重。 */
.agent-loading-face.is-master {
  background: #f6b73c;
  color: #fff;
  border: 1px solid #f6b73c;
}
/* sub：描边圆（透明底 + 暖橙描边 + 橙字），子 agent 运行中。 */
.agent-loading-face.is-sub {
  background: transparent;
  color: #b45309;
  border: 1.5px solid rgba(246, 183, 60, 0.85);
}
/* ghost：虚线圆 + 降透明度，子 agent 已完成等待。 */
.agent-loading-face.is-ghost {
  background: transparent;
  color: fade(@ink, 55%);
  border: 1.5px dashed rgba(36, 38, 45, 0.32);
  opacity: 0.55;
}
.agent-loading-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.agent-loading-copy b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: fade(@ink, 80%);
  font-size: 11px;
}
.agent-loading-copy small,
.batch-loading {
  color: fade(@ink, 48%);
  font-size: 9.5px;
}
.typing-dots {
  display: inline-flex;
  gap: 2px;
}
.typing-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #6366f1;
  animation: history-typing 1.1s ease-in-out infinite;
}
.typing-dots i:nth-child(2) {
  animation-delay: 0.16s;
}
.typing-dots i:nth-child(3) {
  animation-delay: 0.32s;
}
.agent-done {
  color: #16a34a;
  font-size: 12px;
  font-weight: 900;
}
.batch-loading {
  padding: 3px 4px;
  text-align: center;
}
@keyframes history-typing {
  0%,
  60%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

.usage-bar-wrap {
  padding: 6px 14px 8px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.08);
  background: rgba(255, 255, 255, 0.4);
  display: flex;
  flex-direction: column;
  gap: 4px;

  &.usage-low {
    --usage-color: #22c55e;
    --usage-bg: rgba(34, 197, 94, 0.18);
  }
  &.usage-mid {
    --usage-color: #eab308;
    --usage-bg: rgba(234, 179, 8, 0.22);
  }
  &.usage-high {
    --usage-color: #ef4444;
    --usage-bg: rgba(239, 68, 68, 0.22);
  }

  .usage-bar-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .usage-legend {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    row-gap: 2px;
    column-gap: 6px;
    overflow: hidden;

    .legend-item {
      display: inline-flex;
      align-items: baseline;
      gap: 2px;
      font-size: 9px;
      line-height: 1;
      white-space: nowrap;
    }

    .legend-item.is-zero .legend-tokens {
      opacity: 0.5;
    }

    .legend-label {
      font-weight: 600;
    }

    .legend-thinking {
      opacity: 0.55;
    }

    .legend-tokens {
      font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      color: fade(@ink, 60%);
    }
  }

  .usage-label {
    font-size: 10px;
    color: fade(@ink, 52%);
    letter-spacing: 0.02em;
  }
  .usage-label-hover {
    cursor: pointer;
    &:hover {
      color: fade(@ink, 78%);
    }
  }

  .usage-values {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 600;
    color: fade(@ink, 78%);

    .usage-used {
      color: var(--usage-color);
      font-weight: 800;
    }

    .usage-sep {
      opacity: 0.5;
    }

    .usage-total {
      opacity: 0.7;
    }

    .usage-pct {
      margin-left: 6px;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--usage-bg);
      color: var(--usage-color);
      font-weight: 800;
      font-size: 10px;
    }
  }

  .usage-track {
    height: 3px;
    border-radius: 2px;
    background: rgba(36, 38, 45, 0.08);
    overflow: hidden;
    display: flex;
    gap: 2px;

    .usage-seg {
      height: 100%;
      flex-shrink: 0;
      min-width: 8px;
      transition: width 0.3s ease;
    }

    .usage-fill {
      height: 100%;
      background: var(--usage-color);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
  }
}
</style>
