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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
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
import { splitCommandPrompt } from '../composables/commands'
import PromptSnapshotTip from './PromptSnapshotTip.vue'
import ContextUsageBar from './ContextUsageBar.vue'
import type {
  ChatSummary,
  ConversationBranchSummary,
  GenerationEntry,
  GraphToolCall,
  PromptSnapshotTool,
  RootTimelineSnapshot,
  RuntimeSelection,
  TimelineNode,
} from '@/services/agentApi'
import { agentApi } from '@/services/agentApi'
import type { GenerationPayload } from '@/stores/chats/rootTimeline'
import { useChatSessionData } from '@/stores/chats/useChatSessionData'
import { toHistoryItem } from '@/stores/chats/selectors'
import { detailBranchContextNodes } from './detailBranchContext'

const MotionDiv = motion.div

/** 按消息内容估算未量测项的高度，量测完成后由 VirtualScroll 替换。
 *  senseCollapsed=true 时 senseCalls 折叠为一行小 tag（~22px），不再按逐个 box 叠高度。 */
function estimateHeight(item: HistoryItem | undefined, senseCollapsed = false): number {
  if (!item) return 120
  const role = item.role
  if (role === 'user' || role === 'master') return 90
  const hasThinking = !!item.thinking && item.thinking.trim().length > 0
  const senseCount = item.senseCalls?.length ?? 0
  if (senseCollapsed) {
    if (hasThinking && senseCount > 0) return 240
    if (hasThinking) return 220
    if (senseCount > 0) return 150
    return 130
  }
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
    ...(node.runtime ? { runtime: node.runtime } : {}),
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

/** 估高入口：感知工具调用折叠开关（VirtualScroll 只在未量测时用估值，实测后自动替换）。 */
const estimateSize = (item: HistoryItem | undefined): number =>
  estimateHeight(item, agents.senseCallsCollapsed)

const pet = computed(() => agents.petForChat(props.chatId))
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

// ── 根会话切换下拉（方案 A，仅 root/group 面板）：列同 preset 工作区的 root 会话，
//   选中 → openRoot 重置栈到该 root。纯本地查看切换，不写 activeRootByPreset/activeNyxusChatId。 ──
const scopedPreset = computed<{ presetId?: string; presetName?: string }>(() => {
  const s = agents.summaryForChat(props.chatId)
  return {
    presetId: s?.presetId ?? pet.value?.presetId,
    presetName: s?.preset ?? pet.value?.preset,
  }
})
const rootOptions = computed<ChatSummary[]>(() => {
  const { presetId, presetName } = scopedPreset.value
  return agents.historyList
    .filter(
      (c) => !c.parentChatId && (presetId ? c.presetId === presetId : c.preset === presetName),
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
})
function rootOptionLabel(c: ChatSummary): string {
  const preview = c.preview?.trim()
  const when = c.updatedAt
    ? new Date(c.updatedAt).toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  // 用户消息含指令/角色 token（[[command:/x]] / [[role:@x]]），下拉展示去掉双中括号、保留内文
  const plain = preview
    ? splitCommandPrompt(preview)
        .map((seg) => seg.value)
        .join('')
    : ''
  return `${when}${plain ? ' · ' + plain : ''}`
}

const taskBranches = ref<ConversationBranchSummary[]>([])
const taskTimeline = ref<RootTimelineSnapshot>()
const taskId = computed(() => agents.summaryForChat(props.chatId)?.taskId)
watch(
  taskId,
  (id) => {
    taskBranches.value = agents.historyDrawerTaskBranches
    taskTimeline.value = undefined
    if (!id) return
    const requestedTaskId = id
    void agentApi
      .getTaskTimeline({ taskId: id, view: 'conversation' })
      .then((snapshot) => {
        if (taskId.value === requestedTaskId) {
          taskTimeline.value = snapshot
          taskBranches.value = snapshot.branches ?? []
          agents.historyDrawerTaskBranches = taskBranches.value
        }
      })
      .catch(() => undefined)
  },
  { immediate: true },
)
const orderedTaskBranches = computed(() =>
  taskBranches.value.slice().sort((a, b) => {
    if (a.branchId === taskTimeline.value?.activeBranchId) return -1
    if (b.branchId === taskTimeline.value?.activeBranchId) return 1
    if (a.kind === 'detail' && b.kind !== 'detail') return 1
    if (b.kind === 'detail' && a.kind !== 'detail') return -1
    return a.createdAt - b.createdAt || a.branchId.localeCompare(b.branchId)
  }),
)
const currentTaskBranch = computed(() =>
  taskBranches.value.find((branch) => branch.chatId === props.chatId),
)
function branchOptionLabel(branch: ConversationBranchSummary): string {
  const prefix =
    branch.branchId === taskTimeline.value?.activeBranchId
      ? '主流程'
      : branch.kind === 'detail'
        ? '解释'
        : branch.kind === 'original'
          ? '原流程'
          : '继续'
  const plain = splitCommandPrompt(branch.title?.trim() || '未命名问题')
    .map((segment) => segment.value)
    .join('')
  return `${prefix} · ${plain}`
}
// ── 会话级联切换（原「根会话 + 任务分支」两个下拉合并为一个两级 cascader）：
//    第一级 = 任务（rootOptions 按 ChatSummary.taskId 分组，无 taskId 各自成组）；
//    第二级 = 该任务的分支会话--当前任务用 timeline 分支摘要（主流程排前），其他任务用
//    ChatSummary.branchKind 前缀退化。checkStrictly：点第一级任务节点直接切到其代表会话
//    （当前任务 = activeBranch，其他 = 最近会话）。value 恒为 chatId，change 统一 openRoot。 ──
interface SessionCascadeOption {
  value: string
  label: string
  children?: SessionCascadeOption[]
}

/** 非 timeline 来源的分支前缀（其他任务的分支会话仅 ChatSummary.branchKind 可用）。 */
function summaryBranchPrefix(c: ChatSummary): string {
  if (c.branchKind === 'original') return '原流程 · '
  if (c.branchKind === 'continuation') return '继续 · '
  if (c.branchKind === 'detail') return '解释 · '
  return ''
}

const cascadeOptions = computed<SessionCascadeOption[]>(() => {
  // 按 taskId 聚任务组；无 taskId 的会话各自成组（key 唯一即可）
  const groups = new Map<string, ChatSummary[]>()
  for (const c of rootOptions.value) {
    const key = c.taskId ?? `chat:${c.chatId}`
    const list = groups.get(key)
    if (list) list.push(c)
    else groups.set(key, [c])
  }
  const options: SessionCascadeOption[] = []
  for (const [key, chats] of groups) {
    const sorted = chats.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const latest = sorted[0]!
    // 当前任务：分支摘要做第二级；不在分支列表的会话兜底追加（historyList 未含分支 chat 时）
    if (key === taskId.value && orderedTaskBranches.value.length > 0) {
      const branches = orderedTaskBranches.value
      const branchChatIds = new Set(branches.map((b) => b.chatId))
      const children: SessionCascadeOption[] = branches.map((b) => ({
        value: b.chatId,
        label: branchOptionLabel(b),
      }))
      for (const c of sorted) {
        if (!branchChatIds.has(c.chatId))
          children.push({ value: c.chatId, label: rootOptionLabel(c) })
      }
      const activeChatId =
        branches.find((b) => b.branchId === taskTimeline.value?.activeBranchId)?.chatId ??
        branches[0]!.chatId
      options.push({ value: activeChatId, label: rootOptionLabel(latest), children })
      continue
    }
    // 单会话组（无分支）：叶子节点直接可选，不展开空二级
    if (sorted.length === 1) {
      options.push({ value: sorted[0]!.chatId, label: rootOptionLabel(sorted[0]!) })
      continue
    }
    options.push({
      value: latest.chatId,
      label: rootOptionLabel(latest),
      children: sorted.map((c) => ({
        value: c.chatId,
        label: summaryBranchPrefix(c) + rootOptionLabel(c),
      })),
    })
  }
  return options
})

/** el-cascader 行为：任意层级可选（emitPath:false -> value 为节点值即 chatId）。 */
const cascadeProps = { checkStrictly: true, emitPath: false } as const

function onSwitchCascade(value: unknown): void {
  const cid = typeof value === 'string' ? value : ''
  if (!cid || cid === props.chatId) return
  manager.openRoot(cid)
}
const activatingBranch = ref(false)
async function activateCurrentBranch(): Promise<void> {
  const branch = currentTaskBranch.value
  if (!branch || branch.kind === 'detail' || branch.branchId === taskTimeline.value?.activeBranchId)
    return
  activatingBranch.value = true
  try {
    await agentApi.activateBranch(branch.branchId, crypto.randomUUID())
    if (taskId.value)
      taskTimeline.value = await agentApi.getTaskTimeline({
        taskId: taskId.value,
        view: 'conversation',
      })
  } finally {
    activatingBranch.value = false
  }
}
// 从非 Pad 入口开 drawer 时 historyList 可能未加载，懒拉一次供下拉用。
watch(
  () => [layout.value, agents.historyList.length],
  ([l, len]) => {
    if (l === 'group' && !len) void agents.fetchHistoryList()
  },
  { immediate: true },
)

const branchHistory = computed<HistoryItem[]>(() => {
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
    const rootSession = chatSessions.sessionsById[props.chatId]
    for (const messageId of rootSession?.messageOrder ?? []) {
      const message = rootSession?.messagesById[messageId]
      if (message?.delivery?.status === 'failed') transient.push(toHistoryItem(message))
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
  // 子 agent 消息显示模式（show/collapse/round）：仅作用于主 chat 合并视图（group）。
  // 子 agent 数据仍可经主 pet 消息内 spawn_role sense call 的「详情」下钻查看；
  // 下钻打开的子 chat 自身抽屉（direct layout）必须照常显示，不受显示模式影响。
  return applySubagentDisplay(merged)
})

const detailContextHistory = computed<HistoryItem[]>(() => {
  const currentIds = new Set(branchHistory.value.map((item) => item.msgId).filter(Boolean))
  const context = detailBranchContextNodes(taskTimeline.value, currentTaskBranch.value)
    .map(rootNodeToHistory)
    .filter((item) => !item.msgId || !currentIds.has(item.msgId))
  return applySubagentDisplay(dedupHistoryByMsgId(context))
})

const history = computed<HistoryItem[]>(() => [
  ...detailContextHistory.value,
  ...branchHistory.value,
])
const detailBranchStartIndex = computed(() => detailContextHistory.value.length)
const showDetailBranchDivider = computed(
  () => detailBranchStartIndex.value > 0 && branchHistory.value.length > 0,
)

// ── 打包代际（长会话代际分割）：首层卡片条 + 二层代际抽屉（栈深恒 ≤2） ──

/** 已定稿代际（除上一代、当前代外），与树中 pack 节点同数据（snapshot.generations）。 */
const packedGenerations = computed<GenerationEntry[]>(() => {
  if (layout.value !== 'group') return []
  const generations = chatSessions.rootTimeline(props.chatId, 'conversation')?.generations ?? []
  return generations.filter((entry) => entry.index <= generations.length - 2)
})

const activeGenerationIndex = ref<number>()
const generationPayload = ref<GenerationPayload>()
const generationLoading = ref(false)
const generationError = ref('')

/** 二层开关的唯一水源是 agents.historyDrawerGeneration（卡片点击 / 树 pack 节点联动共用）。 */
watch(
  () => agents.historyDrawerGeneration,
  async (request) => {
    if (!request || request.rootChatId !== props.chatId || layout.value !== 'group') {
      activeGenerationIndex.value = undefined
      generationPayload.value = undefined
      generationError.value = ''
      return
    }
    if (request.generationIndex === activeGenerationIndex.value) return
    activeGenerationIndex.value = request.generationIndex
    generationPayload.value = undefined
    generationError.value = ''
    generationLoading.value = true
    try {
      generationPayload.value = await chatSessions.loadGeneration(
        props.chatId,
        request.generationIndex,
      )
    } catch (error) {
      generationError.value = error instanceof Error ? error.message : '代际历史加载失败'
    } finally {
      generationLoading.value = false
    }
  },
  { immediate: true },
)

/** 二层代际对话：generation.get nodes → 现有 conversation 投影（rootNodeToHistory）。 */
const generationHistory = computed<HistoryItem[]>(() => {
  const payload = generationPayload.value
  if (!payload) return []
  return applySubagentDisplay(
    dedupHistoryByMsgId(
      payload.nodes
        .filter((node) => node.visibility === 'conversation' || !!node.termination)
        .map(rootNodeToHistory)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    ),
  )
})

/** 卡片 / 二层标题摘要：首行截断（换行折叠 + 限长 ellipsis）。 */
function generationSummaryLine(entry: GenerationEntry, maxLen = 24): string {
  const compact = entry.summary.replace(/\s+/g, ' ').trim()
  const line = compact.length > maxLen ? compact.slice(0, maxLen) + '…' : compact
  return line || '(无摘要)'
}

function openGenerationCard(generationIndex: number): void {
  agents.openHistoryGeneration(props.chatId, generationIndex)
}

function closeGenerationLayer(): void {
  agents.closeHistoryGeneration()
}

const generationScrollRef = ref<VirtualScrollInstance | null>(null)
// 二层代际数据就绪 → 滚到底（对齐首层 loaded 行为）
watch(
  () => generationHistory.value.length > 0 && !generationLoading.value,
  (ready) => {
    if (ready) void nextTick(() => generationScrollRef.value?.scrollToEnd('auto'))
  },
)

/** 子 agent 消息角色（role='role'/'subagent'）。 */
const SUB_ROLES = new Set<HistoryItem['role']>(['role', 'subagent'])

/** 按当前子 agent 显示模式过滤历史（仅 group 合并视图生效；direct 子 chat 自身抽屉不过滤）。 */
function applySubagentDisplay(items: HistoryItem[]): HistoryItem[] {
  if (layout.value !== 'group') return items
  const mode = agents.subagentDisplay
  if (mode === 'show') return items
  if (mode === 'collapse') return items.filter((item) => !SUB_ROLES.has(item.role))
  // mode === 'round'：每条用户消息一轮，轮内只保留该轮用户消息 + 最后一条回复消息。
  return keepLastPerRound(items)
}

/** 轮次压缩：用户消息开启一轮，到下一用户消息前为同一轮。
 *  每轮保留开头用户消息 + 轮内最后一条非用户消息（作为大模型最终回复，可能是
 *  assistant/master/role——多 agent 场景下主大模型回复常经子 agent 合并成 role）。
 *  中间过程（子 agent、中间大模型回复）丢弃。 */
function keepLastPerRound(items: HistoryItem[]): HistoryItem[] {
  const result: HistoryItem[] = []
  let firstUser: HistoryItem | null = null
  let lastReply: HistoryItem | null = null
  const flush = () => {
    // 用户消息 + 该轮最后一条回复各保留一条；无用户消息（如历史首条即回复）则只留最后一条回复。
    if (firstUser) result.push(firstUser)
    if (lastReply) result.push(lastReply)
    firstUser = null
    lastReply = null
  }
  for (const item of items) {
    if (item.role === 'user') {
      flush()
      firstUser = item
    } else {
      lastReply = item
    }
  }
  flush()
  return result
}
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
    if (candidate.instanceId === pet.value?.instanceId) return true
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

function retryOutgoing(payload: { messageId: string; chatId?: string }): void {
  void chatSessions
    .retryInput(payload.chatId ?? props.chatId, payload.messageId)
    .catch(() => undefined)
}

function removeOutgoing(payload: { messageId: string; chatId?: string }): void {
  chatSessions.removeFailedInput(payload.chatId ?? props.chatId, payload.messageId)
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

/** 级联下拉作为标题：同 preset 存在多个可切换会话/分支且非 workbench-docked 模式时，静态标题
 *  隐去，由级联下拉承载占位。工作台 dock 模式不显示任何切换下拉（分支/会话切换走工作台自身节点树）。 */
const dropdownAsTitle = computed(
  () =>
    layout.value === 'group' &&
    agents.historyDrawerMode !== 'workbench-docked' &&
    (rootOptions.value.length > 1 || orderedTaskBranches.value.length > 1),
)

/** 6c：解析某条历史消息所属 chat 的 pet runtime 兜底（subPetChatId 优先 → agentChatId → 当前 drawer chat）。
 * 旧历史项无 runtime 时，优先用 V2 session 当前 runtime 补全，再退化到 pet 投影。 */
function runtimeForItem(item: HistoryItem): RuntimeSelection | undefined {
  const chatId = item.subPetChatId ?? item.agentChatId ?? props.chatId
  return chatSessions.sessionsById[chatId]?.context.runtime ?? agents.petForChat(chatId)?.runtime
}

// 6d：真人头像 hover 的「系统提示」描述库（打开抽屉随机一套，整次打开稳定，不随 hover 重随机）。
const USER_AVATAR_CAPTIONS = [
  '你是一个全能真人用户。能力：观察上下文、澄清歧义、拍板决策、编写任务说明。约束：一次只给一个明确意图；破坏性操作前先确认；尊重 agent 的判断。',
  '你是人类指挥者。能力：拆解目标、给出硬约束、评估产出。约束：不重复描述既有事实；对不确定处明确提问；批量操作前先小样验证。',
  '你是真人协作者。能力：注入领域知识、设定验收标准、仲裁分歧。约束：信息一次给全；不臆造既定事实；对安全敏感操作保持谨慎。',
  '你是具有判断力的真人。能力：快速理解上下文、给出可行性反馈、追加迭代任务。约束：先对齐再行动；不打断保护性检查；长任务分步推进。',
  '你是谨慎的真人决策者。能力：识别风险、权衡取舍、验收输出。约束：变更先说明理由；对成本/风险显式确认；不把确定性逻辑甩给模型。',
]
const userAvatarCaption = ref('')
onMounted(() => {
  userAvatarCaption.value =
    USER_AVATAR_CAPTIONS[Math.floor(Math.random() * USER_AVATAR_CAPTIONS.length)]!
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
        <span v-if="!dropdownAsTitle" class="title">{{ titleText }}</span>
        <!-- 会话级联切换：第一级任务，第二级分支；仅 pet 直开的 overlay 抽屉显示（工作台 dock 模式走自身节点树） -->
        <el-cascader
          v-if="dropdownAsTitle"
          class="cascade-switch"
          size="small"
          :model-value="props.chatId"
          :options="cascadeOptions"
          :props="cascadeProps"
          placeholder="切换会话"
          aria-label="切换会话或任务分支"
          @change="onSwitchCascade"
        />
        <button
          v-if="
            currentTaskBranch &&
            currentTaskBranch.kind !== 'detail' &&
            currentTaskBranch.branchId !== taskTimeline?.activeBranchId
          "
          type="button"
          class="activate-branch-btn"
          :disabled="activatingBranch"
          title="将当前分支切换为任务主流程；不会复制消息或启动执行"
          @click="activateCurrentBranch"
        >
          设为主流程
        </button>
        <button
          type="button"
          class="copy-id-btn"
          :class="{ copied }"
          :title="copied ? '已复制' : '复制 ID'"
          aria-label="复制 chatId"
          @click="copyChatId"
        >
          <span class="copy-glyph">{{ copied ? '✓' : '📋' }}</span>
        </button>
      </div>
      <div v-if="isTop" class="head-actions">
        <button
          type="button"
          class="tool-collapse-btn"
          :class="{ active: agents.senseCallsCollapsed }"
          :aria-pressed="agents.senseCallsCollapsed"
          title="折叠工具调用为标签（hover 标签查看详情）"
          @click="agents.setSenseCallsCollapsed(!agents.senseCallsCollapsed)"
        >
          🧰
        </button>
        <div
          v-if="layout === 'group'"
          class="display-mode-seg"
          role="group"
          aria-label="子 agent 消息显示模式"
        >
          <button
            type="button"
            class="mode-btn"
            :class="{ active: agents.subagentDisplay === 'show' }"
            :aria-pressed="agents.subagentDisplay === 'show'"
            title="不折叠子 Agent 消息"
            @click="agents.setSubagentDisplay('show')"
          >
            👥</button
          ><button
            type="button"
            class="mode-btn"
            :class="{ active: agents.subagentDisplay === 'collapse' }"
            :aria-pressed="agents.subagentDisplay === 'collapse'"
            title="折叠子 Agent 消息"
            @click="agents.setSubagentDisplay('collapse')"
          >
            🙈</button
          ><button
            type="button"
            class="mode-btn"
            :class="{ active: agents.subagentDisplay === 'round' }"
            :aria-pressed="agents.subagentDisplay === 'round'"
            title="只保留用户和大模型单个轮次最后一条消息"
            @click="agents.setSubagentDisplay('round')"
          >
            🎯
          </button>
        </div>
        <button type="button" class="close-btn" aria-label="Close" @click="manager.closeTop()">
          ✕
        </button>
      </div>
    </header>
    <ContextUsageBar
      v-if="pet?.contextBreakdown?.total"
      :usage="pet?.contextUsage ?? 0"
      :breakdown="pet?.contextBreakdown"
      variant="inline"
    >
      <template #label>
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
      </template>
    </ContextUsageBar>

    <div class="drawer-body">
      <!-- 打包代际卡片条：与树中 pack 节点同数据，点击开二层代际抽屉 -->
      <div
        v-if="packedGenerations.length"
        class="generation-cards"
        role="group"
        aria-label="打包历史"
      >
        <button
          v-for="gen in packedGenerations"
          :key="gen.index"
          type="button"
          class="generation-card"
          :class="{ active: gen.index === activeGenerationIndex }"
          :title="gen.summary"
          @click="openGenerationCard(gen.index)"
        >
          <span class="generation-card-summary">{{ generationSummaryLine(gen) }}</span>
          <span class="generation-card-meta">
            {{ gen.nodeCount }} 节点 · {{ gen.trigger === 'auto' ? '自动' : '手动' }}
          </span>
        </button>
      </div>
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
        :estimate-size="estimateSize"
        :default-render-count="12"
      >
        <template #default="{ index }">
          <div :class="{ 'detail-context-item': index < detailBranchStartIndex }">
            <div
              v-if="showDetailBranchDivider && index === detailBranchStartIndex"
              class="detail-branch-divider"
              role="separator"
              aria-label="解释分支开始"
            >
              <span>以上为创建解释分支时的前置对话</span>
              <strong>以下为解释分支</strong>
            </div>
            <MessageBubble
              :item="history[index]!"
              :layout="layout"
              :collapse-sense-calls="agents.senseCallsCollapsed"
              :master-pet-name="masterPetName"
              :sub-pet-name="subPetName(history[index]!)"
              :sub-pet-face="subPetFace(history[index]!)"
              :sub-pet-type="subPetType(history[index]!)"
              :caller-pet-face="callerPetFace(history[index]!)"
              :caller-pet-name="callerPetName(history[index]!)"
              :caller-is-master="callerIsMaster(history[index]!)"
              :show-master-badge="isLastSubReply(history[index]!)"
              :fallback-runtime="runtimeForItem(history[index]!)"
              :user-avatar-caption="userAvatarCaption"
              @jump-to-spawn="onJumpToSpawn"
              @retry-message="retryOutgoing"
              @remove-message="removeOutgoing"
            />
          </div>
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

    <!-- 二层代际抽屉：覆盖首层（栈深恒 ≤2，二层内无下钻/无分支入口） -->
    <div
      v-if="activeGenerationIndex !== undefined"
      class="generation-layer"
      role="dialog"
      aria-modal="true"
      :aria-label="`打包历史 第 ${activeGenerationIndex} 代`"
    >
      <header class="generation-layer-head">
        <span class="generation-layer-title">
          打包历史 · 第 {{ activeGenerationIndex }} 代
          <small v-if="generationPayload">
            {{ generationPayload.generation.nodeCount }} 节点 ·
            {{ generationPayload.generation.trigger === 'auto' ? '自动压缩' : '手动压缩' }}
          </small>
        </span>
        <button
          type="button"
          class="close-btn generation-layer-close"
          aria-label="关闭打包历史"
          @click="closeGenerationLayer"
        >
          ✕
        </button>
      </header>
      <div class="generation-layer-body">
        <div v-if="generationLoading" class="loading-row">载入代际历史…</div>
        <div v-else-if="generationError" class="empty-row" role="alert">{{ generationError }}</div>
        <div v-else-if="generationHistory.length === 0" class="empty-row">该代无对话内容</div>
        <VirtualScroll
          v-else
          ref="generationScrollRef"
          class="history-list"
          :items="generationHistory"
          :item-key="getHistoryItemKey"
          :estimate-size="estimateSize"
          :default-render-count="12"
        >
          <template #default="{ index }">
            <MessageBubble
              :item="generationHistory[index]!"
              layout="group"
              :collapse-sense-calls="agents.senseCallsCollapsed"
              :master-pet-name="masterPetName"
              :sub-pet-name="subPetName(generationHistory[index]!)"
              :sub-pet-face="subPetFace(generationHistory[index]!)"
              :sub-pet-type="subPetType(generationHistory[index]!)"
              :caller-pet-face="callerPetFace(generationHistory[index]!)"
              :caller-pet-name="callerPetName(generationHistory[index]!)"
              :caller-is-master="callerIsMaster(generationHistory[index]!)"
              :show-master-badge="isLastSubReply(generationHistory[index]!)"
              :fallback-runtime="runtimeForItem(generationHistory[index]!)"
              :user-avatar-caption="userAvatarCaption"
            />
          </template>
        </VirtualScroll>
      </div>
    </div>
  </MotionDiv>
</template>

<style scoped lang="less">
@ink: var(--ink);

// 面板绝对定位叠加（栈中多面板同位置 right:0，靠 z-index + DOM 顺序层叠）
.drawer-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: min(var(--drawer-w, clamp(320px, 40vw, 560px)), calc(100% - 16px));
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-left: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
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
    background: color-mix(in srgb, var(--ink) 18%, transparent);
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
  // 标题栏与滚动区区分：着色带底（浅色主题略深、深色主题略亮）+ 加深底边 + 轻投影。
  // 原 --surface-soft 半透明层与列表区 --panel 几乎无差，辨识度不足。
  background: color-mix(in srgb, var(--ink) 5%, var(--panel));
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.06);
  flex-shrink: 0;

  .title-block {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .title {
    // 标题抢占剩余空间并先 ellipsis（flex-basis 0 + flex:1 + overflow ellipsis），
    // 让过长标题截断而非推挤右侧操作组（6a）。
    flex: 1 1 0;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  // 复制 chatId 按钮：纯 icon（📋/✓），hover title 提示。不随空间压缩（flex-shrink:0）。
  .copy-id-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
    border-radius: 5px;
    background: var(--surface-soft);
    color: color-mix(in srgb, var(--ink) 50%, transparent);
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 10px;
    line-height: 1.4;
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease;

    &:hover {
      background: var(--surface);
      color: color-mix(in srgb, var(--ink) 78%, transparent);
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

  // 会话级联切换（el-cascader）：作为标题展示。
  // 存在下拉时静态 .title 隐去，下拉 flex:1 抢占标题区，承载标题职能。
  .cascade-switch {
    align-self: center;
    flex: 1 1 0;
    min-width: 0;
    :deep(.el-input__wrapper) {
      background: var(--surface-soft);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent) inset;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    :deep(.el-input__inner) {
      color: color-mix(in srgb, var(--ink) 86%, transparent);
      font-weight: 600;
      cursor: pointer;
    }
    :deep(.el-input__inner::placeholder) {
      color: color-mix(in srgb, var(--ink) 45%, transparent);
    }
    :deep(.el-input__suffix) {
      color: color-mix(in srgb, var(--ink) 45%, transparent);
    }
  }
}

// 头部右侧操作组（工具调用折叠开关 + 折叠子 agent + 关闭）
.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

// 工具调用折叠开关：单按钮 toggle，active 高亮与 .display-mode-seg .mode-btn.active 一致
.tool-collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease;

  &:hover {
    background: var(--surface);
    color: color-mix(in srgb, var(--ink) 88%, transparent);
  }

  &.active {
    background: rgba(246, 183, 60, 0.16);
    color: #16a34a;
  }
}

// 子 agent 消息三态显示选择器（group 合并视图）：肩并肩分段按钮，active 高亮。
.display-mode-seg {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  overflow: hidden;

  .mode-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    padding: 0 7px;
    border: 0;
    background: transparent;
    color: color-mix(in srgb, var(--ink) 55%, transparent);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease;

    & + .mode-btn {
      border-left: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
    }

    &:hover {
      background: var(--surface);
      color: color-mix(in srgb, var(--ink) 88%, transparent);
    }

    &.active {
      background: rgba(246, 183, 60, 0.16);
      color: #16a34a;
    }
  }
}

.close-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;

  &:hover {
    background: var(--surface);
    color: color-mix(in srgb, var(--ink) 88%, transparent);
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
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 78%, transparent);
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
    background: var(--surface);
    color: color-mix(in srgb, var(--ink) 92%, transparent);
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
  color: color-mix(in srgb, var(--ink) 48%, transparent);
  font-size: 12px;
  font-style: italic;
}

.history-list {
  flex: 1;
  min-height: 0;
  --virtual-scroll-gap: 10px;
}

.detail-context-item {
  opacity: 0.68;
}

.activate-branch-btn {
  flex: none;
  border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent);
  border-radius: 4px;
  padding: 4px 7px;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 72%, transparent);
  font-size: 11px;
  cursor: pointer;

  &:disabled {
    cursor: wait;
    opacity: 0.5;
  }
}

.detail-branch-divider {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  margin: 2px 6px 14px 0;
  color: color-mix(in srgb, var(--ink) 48%, transparent);
  font-size: 11px;
  line-height: 1.35;

  &::before {
    content: '';
    position: absolute;
    top: 50%;
    right: 6px;
    left: 0;
    border-top: 1px dashed color-mix(in srgb, var(--ink) 18%, transparent);
  }

  span,
  strong {
    position: relative;
    padding: 0 6px;
    background: var(--panel);
  }

  span {
    justify-self: start;
  }

  strong {
    justify-self: end;
    color: color-mix(in srgb, var(--ink) 72%, transparent);
    font-weight: 400;
  }
}

.agent-loading-list {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 14px 0 0;
  padding-top: 8px;
  border-top: 1px dashed color-mix(in srgb, var(--ink) 13%, transparent);
}
.agent-loading-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid rgba(99, 102, 241, 0.16);
  border-radius: 9px;
  background: var(--surface-soft);
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
/* master：实心圆（靛蓝填充 + 深墨字），主 agent 视觉最重。白字在靛蓝上过亮，改深墨提对比（6b）。 */
.agent-loading-face.is-master {
  background: #6366f1;
  color: var(--ink);
  border: 1px solid #f6b73c;
}
/* sub：描边圆（透明底 + 暖橙描边 + 橙字），子 agent 运行中。 */
.agent-loading-face.is-sub {
  background: transparent;
  color: var(--ink);
  color: #b45309;
}
/* ghost：虚线圆 + 降透明度，子 agent 已完成等待。 */
.agent-loading-face.is-ghost {
  background: transparent;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  border: 1.5px dashed color-mix(in srgb, var(--ink) 32%, transparent);
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
  color: color-mix(in srgb, var(--ink) 80%, transparent);
  font-size: 11px;
}
.agent-loading-copy small,
.batch-loading {
  color: color-mix(in srgb, var(--ink) 48%, transparent);
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
}
.typing-dots i:nth-child(2) {
  animation-delay: 0.16s;
}
.typing-dots i:nth-child(3) {
  animation-delay: 0.32s;
}
.agent-done {
  color: var(--ink);
  color: #16a34a;
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

.usage-label {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  letter-spacing: 0.02em;
}
.usage-label-hover {
  cursor: pointer;
  &:hover {
    color: color-mix(in srgb, var(--ink) 78%, transparent);
  }
}

// ── 打包代际：首层卡片条 + 二层代际抽屉 ──
.generation-cards {
  display: flex;
  gap: 8px;
  padding: 0 14px 10px 0;
  overflow-x: auto;
  flex-shrink: 0;
}

.generation-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 148px;
  max-width: 220px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 6px;
  background: var(--surface-soft);
  text-align: left;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background 120ms ease,
    border-color 120ms ease;

  &:hover {
    background: var(--surface);
    border-color: color-mix(in srgb, var(--ink) 24%, transparent);
  }

  &.active {
    background: rgba(246, 183, 60, 0.14);
    border-color: rgba(246, 183, 60, 0.5);
  }
}

.generation-card-summary {
  font-size: 11.5px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 82%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.generation-card-meta {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  white-space: nowrap;
}

// 二层代际抽屉：绝对定位覆盖首层（含 header），背景淡化区分层级（无左侧色条）
.generation-layer {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.22);
}

.generation-layer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  background: rgba(246, 183, 60, 0.07);

  .generation-layer-title {
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    small {
      margin-left: 8px;
      font-size: 10.5px;
      font-weight: 400;
      color: color-mix(in srgb, var(--ink) 52%, transparent);
    }
  }

  .generation-layer-close {
    flex-shrink: 0;
  }
}

.generation-layer-body {
  flex: 1;
  min-height: 0;
  padding: 12px 0 18px 14px;
  display: flex;
  flex-direction: column;
}
</style>
