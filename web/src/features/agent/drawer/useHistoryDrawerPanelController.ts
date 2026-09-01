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
import { useAgentsStore, useChatSessionsStore } from '@/application/public'
import type { HistoryItem } from '@/domain/chat/projectionTypes'
import VirtualScroll from '@/components/VirtualScroll.vue'
import { dedupHistoryByMsgId } from '@/domain/chat/historyProjection'
import {
  reconcileAgentLoadingEntries,
  type AgentLoadingEntry,
} from '@/domain/pets/loadingProjection'
import MessageBubble from '../chat/MessageBubble.vue'
import { useDrawerWidth } from './useDrawerWidth'
import { useSubPetResolution } from '../composables/useSubPetResolution'
import { useHistoryDrawerManager } from './useHistoryDrawerManager'
import { splitCommandPrompt } from '../composables/commands'
import PromptSnapshotTip from './PromptSnapshotTip.vue'
import ContextUsageBar from './ContextUsageBar.vue'
import type {
  ChatSummary,
  ChatEpochSummary,
  ConversationBranchSummary,
  GenerationEntry,
  GraphToolCall,
  PromptSnapshotTool,
  RootTimelineSnapshot,
  RuntimeSelection,
  TimelineNode,
} from '@/application/backend/public'
import { agentApi } from '@/application/backend/public'
import type { GenerationPayload } from '@/application/chat/public'
import { useChatSessionData, toHistoryItem } from '@/application/chat/public'
import { detailBranchContextNodes } from './detailBranchContext'

export type HistoryDrawerPanelControllerProps = {
  /** 本面板要展示的 chat。 */
  chatId: string
  /** 是否栈顶（唯一可交互层；仅栈顶显 ✕）。 */
  isTop: boolean
  /** 嵌入 CyberWindow 时由外层拥有窗口外框，本面板仅保留内容工具栏。 */
  embedded?: boolean
  /** 嵌入态存在更深历史栈时，顶层按钮作为返回而非关闭窗口。 */
  canGoBack?: boolean
  /** 层叠 z-index（280 + N×10 + 1，确保栈顶在上）。 */
  zIndex: number
}

export function useHistoryDrawerPanelController(props: HistoryDrawerPanelControllerProps) {
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
      security: c.security,
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
      ...(node.toolCalls?.length
        ? { senseCalls: node.toolCalls.map(canonicalToolCallToSense) }
        : {}),
      createdAt: node.createdAt,
      msgId: node.id,
      agentChatId: node.sourceChatId,
      ...(childId ? { subPetChatId: childId } : {}),
      ...(node.target?.kind === 'agent' && node.target.chatId !== node.rootChatId
        ? { callerSubPetChatId: node.actor.kind === 'agent' ? node.actor.chatId : node.rootChatId }
        : {}),
      ...(node.kind === 'return' ? { mergedView: 'child-to-master' as const } : {}),
      ...(node.actor.kind === 'agent' && node.actor.roleType
        ? { petName: node.actor.roleType }
        : {}),
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
      // 注入值仅当属于当前任务时暂用（工作台 openHistory 即时显示优化）；跨任务残留
      // （switchSession 切会话不更新全局 historyDrawerTaskBranches）或无任务会话时
      // 过滤为空，避免下拉泄漏别的任务分支。真实数据以 timeline 拉取结果为准。
      taskBranches.value = agents.historyDrawerTaskBranches.filter((branch) => branch.taskId === id)
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
  //    workbench-docked：平铺当前任务分支为一级（主流程/继续/解释，branchOptionLabel 打标，
  //    checkStrictly 可点解释分支切换查看）；overlay：两级——一级 = 任务（rootOptions 按
  //    ChatSummary.taskId 分组，无 taskId 各自成组），二级 = 该任务的分支会话--当前任务用
  //    timeline 分支摘要（主流程排前）且**过滤解释分支**，其他任务用 ChatSummary.branchKind
  //    前缀退化（也过滤解释分支）。checkStrictly：点一级任务节点直接切到其代表会话
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
    // workbench-docked：平铺当前任务分支为一级（含解释流程，可点击切换查看）；
    // 无任务分支（非任务会话 / 分支已清空）时仅当前会话单选项，绝不退化两级跨任务显示。
    if (agents.historyDrawerMode === 'workbench-docked') {
      const branches = orderedTaskBranches.value
      if (branches.length > 0) {
        return branches.map((b) => ({
          value: b.chatId,
          label: branchOptionLabel(b),
        }))
      }
      const current = rootOptions.value.find((c) => c.chatId === props.chatId)
      return current ? [{ value: current.chatId, label: rootOptionLabel(current) }] : []
    }
    // overlay：按 taskId 聚任务组；无 taskId 的会话各自成组（key 唯一即可）
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
      // 当前任务：分支摘要做第二级（过滤解释分支）；不在分支列表的会话兜底追加（historyList 未含分支 chat 时）
      if (key === taskId.value && orderedTaskBranches.value.length > 0) {
        const branches = orderedTaskBranches.value.filter((b) => b.kind !== 'detail')
        if (branches.length > 0) {
          const branchChatIds = new Set(branches.map((b) => b.chatId))
          const children: SessionCascadeOption[] = branches.map((b) => ({
            value: b.chatId,
            label: branchOptionLabel(b),
          }))
          for (const c of sorted) {
            if (c.branchKind !== 'detail' && !branchChatIds.has(c.chatId))
              children.push({ value: c.chatId, label: rootOptionLabel(c) })
          }
          const activeChatId =
            branches.find((b) => b.branchId === taskTimeline.value?.activeBranchId)?.chatId ??
            branches[0]!.chatId
          options.push({ value: activeChatId, label: rootOptionLabel(latest), children })
          continue
        }
        // 该任务仅剩解释分支：降级走下方通用分组逻辑
      }
      // 单会话组（无分支）：叶子节点直接可选，不展开空二级
      if (sorted.length === 1) {
        options.push({ value: sorted[0]!.chatId, label: rootOptionLabel(sorted[0]!) })
        continue
      }
      // 多会话组：二级过滤解释分支；仅剩解释分支时退化为叶子（一级直接可选）
      const nonDetail = sorted.filter((c) => c.branchKind !== 'detail')
      if (nonDetail.length === 0) {
        options.push({ value: latest.chatId, label: rootOptionLabel(latest) })
        continue
      }
      options.push({
        value: latest.chatId,
        label: rootOptionLabel(latest),
        children: nonDetail.map((c) => ({
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
    // 透传当前 mode + anchor：dock 抽屉切分支后仍保持 dock 锚定，不回退 overlay。
    manager.openRoot(cid, agents.historyDrawerMode, agents.historyDrawerAnchor)
  }
  const activatingBranch = ref(false)
  async function activateCurrentBranch(): Promise<void> {
    const branch = currentTaskBranch.value
    if (
      !branch ||
      branch.kind === 'detail' ||
      branch.branchId === taskTimeline.value?.activeBranchId
    )
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
  // run 级中断错误（run 失败时后端 error 通知写入 session.run）：列表末尾告知「这里运行中断了」，
  // 保留至下次 run 清除（新流 chunk / done 时 reducer 清空），不落时间线 DB（error-conventions.md detail 通道）。
  const runFeedbacks = computed(() => {
    const session = chatSessions.sessionsById[props.chatId]
    const persisted = (session?.run.outcomeHistory ?? [])
      .map((entry) => ({
        key: `${entry.runId ?? 'legacy'}:${entry.outcome.reasonCode}:${entry.outcome.occurredAt}`,
        feedback: entry.outcome.feedback,
      }))
      .filter((entry): entry is { key: string; feedback: NonNullable<typeof entry.feedback> } =>
        Boolean(entry.feedback),
      )
    if (persisted.length > 0) return persisted
    const feedback = session?.run.outcome?.feedback ?? session?.run.errorFact?.feedback
    if (feedback) return [{ key: 'current', feedback }]
    const message = session?.run.error
    if (!message) return []
    const canResume = session?.run.errorFact?.canResume === true
    const hasDetails = Boolean(session?.run.errorFact?.tracingId || session?.run.errorFact?.detail)
    return [
      {
        key: 'legacy-error',
        feedback: {
          code: session?.run.errorFact?.code ?? 'INTERNAL',
          severity: 'error' as const,
          source: session?.run.errorFact?.source ?? ('system' as const),
          title: '本轮运行意外中断',
          description: message,
          guidance: canResume ? '检查当前状态后，可以继续运行。' : '请检查输入或配置后重新发送。',
          actions: [
            canResume ? ({ type: 'resume_run' } as const) : ({ type: 'resend_input' } as const),
            ...(hasDetails ? ([{ type: 'view_details' as const }] as const) : []),
          ],
          retention: 'history' as const,
          tracingId: session?.run.errorFact?.tracingId,
          detail: session?.run.errorFact?.detail,
        },
      },
    ]
  })
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
  const { panelStyle, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp } =
    useDrawerWidth()
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
  /** 级联下拉作为标题：workbench-docked 恒显示（分支/会话切换入口，平铺当前任务分支一级）；
   *  overlay 在同 preset 存在多个可切换会话或任务含多个分支时显示。overlay 打开解释分支会话时
   *  其 chatId 不在过滤解释后的二级选项中，降为静态标题（titleText）避免 cascader 值失配。 */
  const dropdownAsTitle = computed(
    () =>
      layout.value === 'group' &&
      (agents.historyDrawerMode === 'workbench-docked'
        ? true
        : currentTaskBranch.value?.kind !== 'detail' &&
          (rootOptions.value.length > 1 || orderedTaskBranches.value.length > 1)),
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
    epochs: ChatEpochSummary[]
    selectedEpochId?: string
    activeEpochId?: string
    snapshotQuality?: 'exact' | 'partial' | 'reconstructed'
  } | null>(null)
  let promptSnapKey = ''
  async function loadPromptSnapshot(chatId: string, epochId?: string): Promise<void> {
    // 同 chat 已加载或加载中 → 不重复请求
    const key = `${chatId}:${epochId ?? 'active'}`
    if (promptSnapKey === key && promptSnap.value && promptSnap.value.status !== 'error') return
    promptSnapKey = key
    try {
      const epochResult = await agentApi.listEpochs(chatId)
      const selectedEpochId = epochId ?? epochResult.activeEpochId
      promptSnap.value = {
        systemPrompt: '',
        tools: [],
        status: 'loading',
        epochs: epochResult.epochs,
        selectedEpochId,
        activeEpochId: epochResult.activeEpochId,
      }
      const res = await agentApi.promptSnapshot(chatId, selectedEpochId)
      const effectiveSelectedEpochId = res.epochId ?? selectedEpochId
      // chatId 期间未切换才写入（避免竞态覆盖）
      if (promptSnapKey === key) {
        promptSnap.value = {
          systemPrompt: res.systemPrompt,
          tools: res.tools,
          status: 'loaded',
          epochs: epochResult.epochs,
          selectedEpochId: effectiveSelectedEpochId,
          activeEpochId: epochResult.activeEpochId,
          snapshotQuality: res.snapshotQuality,
        }
      }
    } catch (err) {
      if (promptSnapKey === key) {
        promptSnap.value = {
          systemPrompt: '',
          tools: [],
          status: 'error',
          error: (err as Error).message,
          epochs: promptSnap.value?.epochs ?? [],
          selectedEpochId: epochId,
        }
      }
    }
  }
  function onPromptSnapShow(): void {
    if (!props.chatId) return
    void loadPromptSnapshot(props.chatId)
  }
  function onPromptEpochChange(epochId: string): void {
    if (!props.chatId) return
    void loadPromptSnapshot(props.chatId, epochId)
  }

  return {
    ContextUsageBar,
    MessageBubble,
    PromptSnapshotTip,
    VirtualScroll,
    activateCurrentBranch,
    activatingBranch,
    activeGenerationIndex,
    agents,
    batchReloading,
    callerIsMaster,
    callerPetFace,
    callerPetName,
    cascadeOptions,
    cascadeProps,
    closeGenerationLayer,
    copied,
    copyChatId,
    currentTaskBranch,
    detailBranchStartIndex,
    dropdownAsTitle,
    estimateSize,
    faceStateClass,
    generationError,
    generationHistory,
    generationLoading,
    generationPayload,
    generationScrollRef,
    generationSummaryLine,
    getHistoryItemKey,
    history,
    isLastSubReply,
    layout,
    loaded,
    loadingAgents,
    manager,
    masterPetName,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
    onJumpToSpawn,
    onPromptEpochChange,
    onPromptSnapShow,
    onRailJump,
    onSwitchCascade,
    openGenerationCard,
    packedGenerations,
    panelFullStyle,
    pet,
    previewOf,
    previewTooltip,
    previewTooltipStyle,
    promptSnap,
    ref,
    removeOutgoing,
    retryOutgoing,
    runFeedbacks,
    runtimeForItem,
    scrollToBottomSmooth,
    scrollToTopSmooth,
    showAgentLoading,
    showDetailBranchDivider,
    subPetFace,
    subPetName,
    subPetType,
    taskTimeline,
    titleText,
    userAvatarCaption,
    userMarks,
    virtualScrollRef,
  }
}
