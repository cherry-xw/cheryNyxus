/**
 * 工作台底部 Agent 用量条数据源：主 Agent + 各子 Agent 的 token 上下文、耗时与运行状态。
 *
 * 数据来源：
 * - 主/子 Agent 运行状态与耗时：`chatSessions.executionReadModel`（主/子 Agent 计时权威投影，
 *   运行中按实时时钟推进、终态取固定耗时，与精简模式顶部小块的计时口径一致）。
 * - 主 Agent token 用量：沿用工作台既有 `treeUsage` / `treeBreakdown` 口径（inspector 带降级兜底）。
 * - 子 Agent token 用量：各子会话 `context`（contextBreakdown / contextUsed / contextTotal）。
 * - 主 Agent 模型 / 思考等级：会话 runtime（context.runtime）兜底 primarySelection。
 * - token 速度：前端按秒采样「已用 token + 流式消息估算 token」（字符数/4，与后端 estimateTokens 对齐），
 *   滑动窗口内差分得到 tok/s；空闲时清零。
 *
 * 时钟复用精简模式的 `createLiteExecutionClock`：展示层 ticker，每秒刷新 now，不写回领域状态。
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref,
  toValue,
} from 'vue'
import { createLiteExecutionClock, elapsedTime } from '@/features/lite/executionMonitor'
import { useChatSessionData } from '@/application/chat/public'
import { useChatSessionsStore } from '@/application/public'
import type { ExecutionReadModel, ExecutionRootStatus } from '@/application/chat/public'
import type {
  BrainConfigDto,
  ContextBreakdown,
  RuntimeSelection,
  ThinkingLevel,
} from '@/application/backend/public'

export interface WorkbenchAgentUsageOptions {
  /** 树根会话（主 Agent 会话）chatId；无则空。 */
  rootChatId: MaybeRefOrGetter<string | undefined>
  /** 主 Agent 自身名称（工作台预设名）。 */
  agentName: MaybeRefOrGetter<string | undefined>
  /** 主 Agent 当前编制 runtime（primarySelection）；会话 runtime 缺省时兜底。 */
  runtime: MaybeRefOrGetter<RuntimeSelection | undefined>
  /** brain 配置读取（模型名 / 思考档位 / 上下文上限）。 */
  brainConfig: (name: string) => BrainConfigDto | undefined
  /** 主 Agent 上下文占用比例 0-1（工作台既有口径）。 */
  usage: MaybeRefOrGetter<number>
  /** 主 Agent 上下文 6 段分解（工作台既有口径）。 */
  breakdown: MaybeRefOrGetter<ContextBreakdown | null>
}

export interface WorkbenchAgentUsageView {
  chatId: string
  label: string
  isRoot: boolean
  /** 主 Agent 模型名（brainConfig.model）。 */
  model?: string
  /** 主 Agent 思考等级中文（runtime.thinking / brain 配置兜底）。 */
  thinkingLabel?: string
  running: boolean
  status: ExecutionRootStatus
  elapsedMs: number
  /** 已用 token（子 Agent "X-Y" 中的 X）。 */
  usedTokens?: number
  /** 上下文上限 token（子 Agent "X-Y" 中的 Y）。 */
  totalTokens?: number
  /** 上下文占用比例 0-1。 */
  usage?: number
  breakdown?: ContextBreakdown | null
}

export interface WorkbenchAgentUsage {
  /** 全部 Agent（主 Agent 恒在首位，其后为子 Agent）。 */
  agents: ComputedRef<WorkbenchAgentUsageView[]>
  rootAgent: ComputedRef<WorkbenchAgentUsageView | undefined>
  subAgents: ComputedRef<WorkbenchAgentUsageView[]>
  /** 根任务树是否运行中（运行 / 等待）。 */
  running: ComputedRef<boolean>
  /** 采集到的 token 速度（tok/s，滑动窗口差分）。 */
  tokenSpeed: Ref<number>
  /** 每秒 tick（展示层实时刷新）。 */
  now: Ref<number>
}

/** 估算文本 token（字符数/4 向上取整，与后端 estimateTokens 对齐）。 */
function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** ContextBreakdown 各段之和 = 已用 token。 */
function breakdownUsed(bd: ContextBreakdown): number {
  return (
    bd.system.tokens +
    bd.userSystem.tokens +
    bd.memory.tokens +
    bd.skills.tokens +
    bd.tools.tokens +
    bd.conversation.tokens
  )
}

/** 思考档位 → 中文（与 RoleConfigPopover 同表；未命中原样展示）。 */
const THINKING_LABEL: Record<string, string> = {
  off: '关闭',
  on: '开',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  min: '最低',
  none: '无',
  auto: '自动',
  adaptive: '自适应',
  balanced: '均衡',
  standard: '标准',
  moderate: '适中',
  minimal: '极少',
  deep: '深度',
  extreme: '极限',
  ultra: '极致',
  turbo: '极速',
  full: '全力',
  always: '始终',
  verbose: '详细',
}

function thinkingLabelOf(level: ThinkingLevel | undefined): string | undefined {
  if (!level || level === 'off') return undefined
  return THINKING_LABEL[level] ?? level
}

export function useWorkbenchAgentUsage(options: WorkbenchAgentUsageOptions): WorkbenchAgentUsage {
  const chatSessions = useChatSessionsStore()
  const clock = createLiteExecutionClock()
  onMounted(() => clock.start())
  onBeforeUnmount(clock.stop)

  const rootChatId = computed(() => toValue(options.rootChatId))
  const rootSessionData = useChatSessionData(() => rootChatId.value || undefined)

  const execution = computed<ExecutionReadModel | undefined>(() =>
    rootChatId.value ? chatSessions.executionReadModel(rootChatId.value) : undefined,
  )

  const running = computed<boolean>(() => {
    const ex = execution.value
    return !!ex && (ex.status === 'running' || ex.status === 'waiting')
  })

  // ── 主 Agent token 用量（工作台既有口径：treeUsage / treeBreakdown）──
  const rootBreakdown = computed(() => toValue(options.breakdown))
  const rootUsage = computed(() => toValue(options.usage))
  const rootUsedTokens = computed<number | undefined>(() => {
    const bd = rootBreakdown.value
    if (bd && bd.total > 0) return breakdownUsed(bd)
    const session = rootSessionData.session.value
    const total = session?.context.contextTotal
    if (total && rootUsage.value !== undefined) return Math.round(total * rootUsage.value)
    if (typeof session?.context.contextUsed === 'number') return session.context.contextUsed
    return undefined
  })
  const rootTotalTokens = computed<number | undefined>(() => {
    const bd = rootBreakdown.value
    if (bd && bd.total > 0) return bd.total
    return rootSessionData.session.value?.context.contextTotal
  })
  const rootUsageRatio = computed(() => {
    const bd = rootBreakdown.value
    return bd ? bd.usage : rootUsage.value
  })
  const rootBreakdownValue = computed<ContextBreakdown | null>(() => rootBreakdown.value)

  // ── token 速度：响应期间每秒采样，滑动窗口内差分 → tok/s ──
  // 流式消息内容估算（响应生成期间 token 实时增长；字符数/4 与后端对齐）。
  const activeStreamTokens = computed(() => {
    const msg = rootSessionData.activeMessage.value
    if (!msg) return 0
    return estimateTokens(msg.content) + estimateTokens(msg.thinking)
  })
  const sampledTotal = computed(() => (rootUsedTokens.value ?? 0) + activeStreamTokens.value)

  const SPEED_WINDOW_MS = 20_000
  const speedSamples: Array<{ t: number; tokens: number }> = []
  const tokenSpeed = ref(0)
  watch([clock.now, running], ([now, isRunning]) => {
    if (!isRunning) {
      speedSamples.length = 0
      tokenSpeed.value = 0
      return
    }
    speedSamples.push({ t: now, tokens: sampledTotal.value })
    const windowStart = now - SPEED_WINDOW_MS
    while (speedSamples.length > 2 && (speedSamples[0]?.t ?? 0) < windowStart) speedSamples.shift()
    const first = speedSamples[0]
    const last = speedSamples[speedSamples.length - 1]
    if (!first || !last) {
      tokenSpeed.value = 0
      return
    }
    const spanMs = last.t - first.t
    if (spanMs < 1500) {
      tokenSpeed.value = 0
      return
    }
    tokenSpeed.value = Math.max(0, last.tokens - first.tokens) / (spanMs / 1000)
  })

  // ── Agent 视图：执行读模型计时 + 会话上下文 token ──
  const agents = computed<WorkbenchAgentUsageView[]>(() => {
    const rootId = rootChatId.value
    const ex = execution.value
    if (!rootId) return []
    const now = clock.now.value

    // 当前执行窗口的 Agent 计时（主 + 子）；历史已完成子 Agent 不在其中，由会话数据兜底。
    const timingByChat = new Map<string, ExecutionReadModel['agents'][number]>()
    for (const agent of ex?.agents ?? []) timingByChat.set(agent.chatId, agent)

    const childIds = Object.values(chatSessions.sessionsById)
      .filter((s) => s.meta.parentChatId === rootId)
      .map((s) => s.chatId)
    const chatIds = [rootId, ...childIds]

    return chatIds.map((chatId): WorkbenchAgentUsageView => {
      const session = chatSessions.sessionsById[chatId]
      const timing = timingByChat.get(chatId)
      const isRoot = chatId === rootId

      // 状态与时间：执行读模型优先；缺失时由会话 run / activeRun / executionSteps 兜底。
      let status: ExecutionRootStatus | undefined = timing?.status
      let startedAt = timing?.startedAt
      let completedAt = timing?.completedAt
      if (!timing) {
        const activeRun = session?.activeRun
        const runStatus = activeRun?.status ?? session?.run.status
        if (
          runStatus === 'running' ||
          runStatus === 'waiting' ||
          runStatus === 'paused' ||
          runStatus === 'completed' ||
          runStatus === 'failed' ||
          runStatus === 'cancelled'
        ) {
          status = runStatus
        }
        startedAt = typeof activeRun?.startedAt === 'number' ? activeRun.startedAt : startedAt
        const runEnd =
          typeof activeRun?.completedAt === 'number'
            ? activeRun.completedAt
            : typeof activeRun?.at === 'number'
              ? activeRun.at
              : undefined
        completedAt = runEnd ?? completedAt
        const steps = session?.executionSteps ?? []
        if (steps.some((step) => step.status === 'running')) status = 'running'
        const stepStarts = steps
          .map((step) => step.startedAt)
          .filter((t): t is number => typeof t === 'number')
        if (stepStarts.length && startedAt === undefined) startedAt = Math.min(...stepStarts)
        const stepCompletes = steps
          .map((step) => step.completedAt)
          .filter((t): t is number => typeof t === 'number')
        if (stepCompletes.length) completedAt = Math.max(...stepCompletes)
      }
      const isRunning = status === 'running' || status === 'waiting'
      const elapsedMs =
        startedAt === undefined
          ? 0
          : isRunning
            ? elapsedTime(startedAt, undefined, now)
            : completedAt !== undefined
              ? elapsedTime(startedAt, completedAt, now)
              : 0

      // token 用量：主 Agent 走工作台既有口径；子 Agent 读会话上下文。
      let usedTokens: number | undefined
      let totalTokens: number | undefined
      let usage: number | undefined
      let breakdown: ContextBreakdown | null = null
      if (isRoot) {
        usedTokens = rootUsedTokens.value
        totalTokens = rootTotalTokens.value
        usage = rootUsageRatio.value
        breakdown = rootBreakdownValue.value
      } else {
        const ctx = session?.context
        const bd = ctx?.contextBreakdown
        if (bd && bd.total > 0) {
          usedTokens = breakdownUsed(bd)
          totalTokens = bd.total
          usage = bd.usage
          breakdown = bd
        } else {
          if (typeof ctx?.contextUsed === 'number') usedTokens = ctx.contextUsed
          if (typeof ctx?.contextTotal === 'number') totalTokens = ctx.contextTotal
          else {
            const brain = ctx?.runtime?.brain
            totalTokens = brain ? options.brainConfig(brain)?.contextLimit : undefined
          }
          if (usedTokens === undefined && totalTokens && typeof ctx?.contextUsage === 'number') {
            usedTokens = Math.round(totalTokens * ctx.contextUsage)
          }
          usage =
            usedTokens !== undefined && totalTokens
              ? Math.min(1, usedTokens / totalTokens)
              : typeof ctx?.contextUsage === 'number'
                ? ctx.contextUsage
                : undefined
        }
      }

      // 模型 / 思考等级（仅主 Agent 展示）。
      let model: string | undefined
      let thinkingLabel: string | undefined
      if (isRoot) {
        const runtime = rootSessionData.runtime.value ?? toValue(options.runtime)
        const brain = runtime?.brain
        const cfg = brain ? options.brainConfig(brain) : undefined
        model = cfg?.model
        thinkingLabel = thinkingLabelOf(runtime?.thinking ?? cfg?.thinking)
      }

      return {
        chatId,
        label: isRoot
          ? toValue(options.agentName) || session?.meta.agentType || 'Agent'
          : session?.meta.agentType || timing?.label || 'Agent',
        isRoot,
        ...(model ? { model } : {}),
        ...(thinkingLabel ? { thinkingLabel } : {}),
        running: isRunning,
        status: status ?? (session?.run.status === 'running' ? 'running' : 'idle'),
        elapsedMs,
        ...(usedTokens !== undefined ? { usedTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(usage !== undefined ? { usage } : {}),
        breakdown,
      }
    })
  })

  const rootAgent = computed(() => agents.value.find((agent) => agent.isRoot))
  const subAgents = computed(() => agents.value.filter((agent) => !agent.isRoot))

  return {
    agents,
    rootAgent,
    subAgents,
    running,
    tokenSpeed,
    now: clock.now,
  }
}
