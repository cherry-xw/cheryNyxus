/**
 * 工作台底部 Agent 用量条数据源：主 Agent + 各子 Agent 的 token 上下文、耗时与运行状态。
 *
 * 数据来源：
 * - 主/子 Agent 运行状态与耗时：`chatSessions.executionReadModel`（主/子 Agent 计时权威投影，
 *   运行中按实时时钟推进、终态取固定耗时，与精简模式顶部小块的计时口径一致）。
 * - 主 Agent token 用量：沿用工作台既有 `treeUsage` / `treeBreakdown` 口径（inspector 带降级兜底）。
 * - 子 Agent token 用量：各子会话 `context`（contextBreakdown / contextUsed / contextTotal）。
 * - 主 Agent 模型 / 思考等级：会话 runtime（context.runtime）兜底 primarySelection。
 * - token 速度：前端只对当前主流程 chatId 的流式消息估算 token（字符数/4，与后端 estimateTokens 对齐），
 *   每个 chatId/runId 独立累计并在滑动窗口内差分得到 tok/s。
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
import { createLiteExecutionClock, elapsedTime, projectLiteExecution } from '@/features/lite/executionMonitor'
import { THINKING_LABEL } from '@/features/agent/runtime/roleConfigModel'
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
  /** 当前待审批调用（interactionId → 审批发起时间）；总运行时长在审批等待期间冻结（阻塞等待不计时）。 */
  approvalWait?: MaybeRefOrGetter<ReadonlyMap<string, number> | undefined>
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
  /** 当前主流程会话的 token 速度（tok/s，前端估算）。 */
  tokenSpeed: Ref<number>
  /** 每秒 tick（展示层实时刷新）。 */
  now: Ref<number>
  taskElapsedMs: ComputedRef<number>
}

/** 估算文本 token（字符数/4 向上取整，与后端 estimateTokens 对齐）。 */
function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

interface SpeedSample {
  t: number
  tokens: number
}

/** 单个主流程会话的速度状态；completed turn 的 token 会保留在 generatedTokens 中。 */
interface MainFlowSpeedState {
  runId?: string
  generatedTokens: number
  turnTokens: Map<string, number>
  samples: SpeedSample[]
  lastGrowthAt?: number
  speed: number
}

const TOKEN_SPEED_STORAGE_PREFIX = 'chery:workbench-token-speed:'
const TOKEN_SPEED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function tokenSpeedStorageKey(chatId: string): string {
  return `${TOKEN_SPEED_STORAGE_PREFIX}${encodeURIComponent(chatId)}`
}

interface StoredTokenSpeed {
  speed: number
  savedAt: number
}

function parseStoredTokenSpeed(raw: string | null): StoredTokenSpeed | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTokenSpeed>
    if (
      typeof parsed.speed !== 'number' ||
      !Number.isFinite(parsed.speed) ||
      parsed.speed <= 0 ||
      typeof parsed.savedAt !== 'number' ||
      !Number.isFinite(parsed.savedAt)
    ) {
      return undefined
    }
    if (Date.now() - parsed.savedAt > TOKEN_SPEED_RETENTION_MS) return undefined
    return { speed: parsed.speed, savedAt: parsed.savedAt }
  } catch {
    return undefined
  }
}

function cleanupStoredTokenSpeeds(): void {
  if (typeof localStorage === 'undefined') return
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(TOKEN_SPEED_STORAGE_PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      if (!parseStoredTokenSpeed(localStorage.getItem(key))) localStorage.removeItem(key)
    }
  } catch {
    // localStorage 不可用时只保留当前页面内的状态。
  }
}

function readStoredTokenSpeed(chatId: string): number {
  if (typeof localStorage === 'undefined') return 0
  try {
    const stored = parseStoredTokenSpeed(localStorage.getItem(tokenSpeedStorageKey(chatId)))
    if (!stored) {
      localStorage.removeItem(tokenSpeedStorageKey(chatId))
      return 0
    }
    return stored.speed
  } catch {
    return 0
  }
}

function persistTokenSpeed(chatId: string, speed: number): void {
  if (typeof localStorage === 'undefined' || !Number.isFinite(speed) || speed <= 0) return
  try {
    const stored: StoredTokenSpeed = { speed, savedAt: Date.now() }
    localStorage.setItem(tokenSpeedStorageKey(chatId), JSON.stringify(stored))
  } catch {
    // localStorage 不可用时只保留当前页面内的状态。
  }
}

function createMainFlowSpeedState(runId?: string): MainFlowSpeedState {
  return {
    ...(runId ? { runId } : {}),
    generatedTokens: 0,
    turnTokens: new Map(),
    samples: [],
    speed: 0,
  }
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

/** 思考档位 → 中文（共享表：runtime/roleConfigModel.ts 的 THINKING_LABEL；未命中原样展示）。 */
function thinkingLabelOf(level: ThinkingLevel | undefined): string | undefined {
  if (!level || level === 'off') return undefined
  return THINKING_LABEL[level] ?? level
}

export function useWorkbenchAgentUsage(options: WorkbenchAgentUsageOptions): WorkbenchAgentUsage {
  const chatSessions = useChatSessionsStore()
  const clock = createLiteExecutionClock()
  cleanupStoredTokenSpeeds()
  onMounted(() => clock.start())
  onBeforeUnmount(clock.stop)

  const rootChatId = computed(() => toValue(options.rootChatId))
  const rootSessionData = useChatSessionData(() => rootChatId.value || undefined)

  const execution = computed<ExecutionReadModel | undefined>(() =>
    rootChatId.value ? chatSessions.executionReadModel(rootChatId.value) : undefined,
  )

  // ── 审批等待（阻塞等待）期间停止总运行时长计时 ──
  // 墙钟时长是「任务开始到现在经过的真实时间」，包含所有等待；审批等待期间冻结，
  // 审批决定后从冻结点继续，审批等待不计入总运行时长。
  // 与树模式节点计时同一进出跟踪模式：approvalWaitStart 记录当前审批等待的起点，
  // approvalPausedMs 累计已结束的审批暂停时长。
  const approvalWaitMap = computed<ReadonlyMap<string, number>>(
    () => toValue(options.approvalWait) ?? new Map(),
  )
  const approvalPausedMs = ref(new Map<string, number>())
  const approvalWaitStart = ref(new Map<string, number>())
  let prevApprovalWaitIds: ReadonlySet<string> = new Set()
  watch(
    approvalWaitMap,
    (next) => {
      const now = Date.now()
      const nextPaused = new Map(approvalPausedMs.value)
      const nextStart = new Map(approvalWaitStart.value)
      for (const [id, since] of next) {
        if (!prevApprovalWaitIds.has(id)) nextStart.set(id, since)
      }
      for (const id of prevApprovalWaitIds) {
        if (!next.has(id)) {
          const start = nextStart.get(id)
          if (start !== undefined) {
            nextPaused.set(id, (nextPaused.get(id) ?? 0) + Math.max(0, now - start))
          }
          nextStart.delete(id)
        }
      }
      approvalPausedMs.value = nextPaused
      approvalWaitStart.value = nextStart
      prevApprovalWaitIds = new Set(next.keys())
    },
    { immediate: true },
  )
  /** 当前累计的审批暂停时长（已结束的 + 仍在等待中的当前段）。 */
  const approvalPauseMs = computed(() => {
    const now = clock.now.value
    let total = 0
    for (const paused of approvalPausedMs.value.values()) total += paused
    for (const start of approvalWaitStart.value.values()) total += Math.max(0, now - start)
    return total
  })
  /** 从墙钟时长中扣减审批暂停时长的展示值。 */
  const frozenElapsed = (raw: number): number => Math.max(0, raw - approvalPauseMs.value)

  const running = computed<boolean>(() => {
    const ex = execution.value
    return !!ex && (ex.status === 'running' || ex.status === 'waiting')
  })
  const taskElapsedMs = computed(() =>
    execution.value ? frozenElapsed(projectLiteExecution(execution.value, clock.now.value).elapsedMs) : 0,
  )

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

  // ── 当前主流程 token 速度：按 chatId/runId 独立累计，滑动窗口差分 → tok/s ──
  // root 订阅的 transient activeTurns 覆盖整棵 Agent 树，因此这里只取当前主流程 chatId；
  // 子 Agent 不参与。累计值不依赖 activeTurns 当前长度，turn 完成并移除后也不会倒退。
  const currentMainRunId = computed(() => {
    const chatId = rootChatId.value
    if (!chatId) return undefined
    const transient = chatSessions.rootTimelineStates[chatId]
    const activeRun = transient?.activeRuns.find((run) => run.chatId === chatId)
    if (activeRun?.runId) return activeRun.runId
    const activeTurn = transient?.activeTurns.find(
      (turn) => turn.chatId === chatId && typeof turn.runId === 'string',
    )
    if (activeTurn?.runId) return activeTurn.runId
    const session = chatSessions.sessionsById[chatId]
    if (session?.activeRun?.runId) return session.activeRun.runId
    if (session?.run.activeRunId) return session.run.activeRunId
    const latestRun = transient?.runStates
      .filter((run) => run.chatId === chatId)
      .sort(
        (a, b) =>
          (b.completedAt ?? b.at ?? b.startedAt ?? 0) -
          (a.completedAt ?? a.at ?? a.startedAt ?? 0),
      )[0]
    return latestRun?.runId
  })

  const mainFlowTurns = computed(() => {
    const chatId = rootChatId.value
    if (!chatId) return []
    const transient = chatSessions.rootTimelineStates[chatId]
    // turn.started 的快照可能没有 runId，后续 run.updated 才补充 runId；
    // chatId 才是主流程归属，runId 只用于识别新一轮并重置累计状态。
    return (transient?.activeTurns ?? []).filter((turn) => turn.chatId === chatId)
  })

  const SPEED_WINDOW_MS = 20_000
  const SPEED_MIN_SPAN_MS = 1_500
  const SPEED_PAUSE_RESET_MS = 2_500
  const speedStates = new Map<string, MainFlowSpeedState>()
  const tokenSpeed = ref(0)

  function speedStateFor(chatId: string, runId: string | undefined): MainFlowSpeedState {
    const existing = speedStates.get(chatId)
    if (!existing) {
      const created = createMainFlowSpeedState(runId)
      created.speed = readStoredTokenSpeed(chatId)
      speedStates.set(chatId, created)
      return created
    }
    // 同一个 chatId 开启新 run 时，不能继承上一轮的速度和累计 token。
    if (runId && existing.runId && existing.runId !== runId) {
      const created = createMainFlowSpeedState(runId)
      speedStates.set(chatId, created)
      return created
    }
    if (runId && !existing.runId) existing.runId = runId
    return existing
  }

  watch(
    rootChatId,
    (chatId) => {
      tokenSpeed.value = chatId ? (speedStates.get(chatId)?.speed ?? 0) : 0
    },
    { immediate: true },
  )

  watch([clock.now, rootChatId, currentMainRunId], ([now, chatId, runId]) => {
    if (!chatId) {
      tokenSpeed.value = 0
      return
    }
    const state = speedStateFor(chatId, runId)

    let grew = false
    for (const turn of mainFlowTurns.value) {
      const currentTokens = estimateTokens(turn.content) + estimateTokens(turn.thinking)
      const previousTokens = state.turnTokens.get(turn.turnId) ?? 0
      if (currentTokens > previousTokens) {
        state.generatedTokens += currentTokens - previousTokens
        grew = true
      }
      state.turnTokens.set(turn.turnId, currentTokens)
    }

    if (!grew) {
      // 主流程仍可能处于 running/waiting，但没有新输出；冻结速度，避免窗口滑动造成衰减。
      if (
        state.lastGrowthAt !== undefined &&
        now - state.lastGrowthAt > SPEED_PAUSE_RESET_MS
      ) {
        state.samples.length = 0
      }
      tokenSpeed.value = state.speed
      return
    }

    // 中间停顿后重新输出，从新的连续输出段重新计算，不把等待时间算进 tok/s。
    if (state.lastGrowthAt !== undefined && now - state.lastGrowthAt > SPEED_PAUSE_RESET_MS) {
      state.samples.length = 0
    }
    state.lastGrowthAt = now
    state.samples.push({ t: now, tokens: state.generatedTokens })
    const windowStart = now - SPEED_WINDOW_MS
    while (state.samples.length > 2 && (state.samples[0]?.t ?? 0) < windowStart) {
      state.samples.shift()
    }
    const first = state.samples[0]
    const last = state.samples[state.samples.length - 1]
    if (!first || !last) {
      tokenSpeed.value = state.speed
      return
    }
    const spanMs = last.t - first.t
    if (spanMs < SPEED_MIN_SPAN_MS) {
      tokenSpeed.value = state.speed
      return
    }
    const nextSpeed = Math.max(0, last.tokens - first.tokens) / (spanMs / 1000)
    if (nextSpeed > 0 && nextSpeed !== state.speed) {
      state.speed = nextSpeed
      persistTokenSpeed(chatId, nextSpeed)
    }
    tokenSpeed.value = state.speed
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
      // 审批等待期间冻结「进行中」的 Agent 时长；已完成的 Agent 时长为固定值，不再受后续审批暂停影响。
      const elapsedMs =
        startedAt === undefined
          ? 0
          : isRunning
            ? frozenElapsed(elapsedTime(startedAt, undefined, now))
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
    taskElapsedMs,
  }
}
