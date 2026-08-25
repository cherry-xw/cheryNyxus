import { ref, type Ref } from 'vue'
import type {
  ExecutionReadModel,
  ExecutionReadStep,
  ExecutionRootStatus,
} from '@/stores/chats/executionReadModel'
import type { ExecutionStep, GraphToolCall, TimelineNode } from '@/services/agentApi'
import { executionStepKey } from '@/stores/chats/executionTiming'

export interface LiteExecutionStepView {
  key: string
  id: string
  chatId: string
  agentLabel: string
  kind: ExecutionReadStep['kind']
  name: string
  status: ExecutionReadStep['status']
  startedAt: number
  completedAt?: number
  elapsedMs: number
  active: boolean
  expanded: boolean
}

export interface LiteExecutionMonitorView {
  question: string
  status: ExecutionRootStatus
  statusLabel: string
  startedAt?: number
  completedAt?: number
  elapsedMs: number
  steps: LiteExecutionStepView[]
  activeSteps: LiteExecutionStepView[]
  finalPreview: string
  finalHasMore: boolean
  finalResponseId?: string
}

export const FINAL_PREVIEW_CHAR_LIMIT = 280

const STATUS_LABELS: Readonly<Record<ExecutionRootStatus, string>> = {
  idle: '等待开始',
  running: '执行中',
  waiting: '等待中',
  paused: '已暂停',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
}

function terminalTime(
  startedAt: number | undefined,
  completedAt: number | undefined,
  fallbackCompletedAt: number | undefined,
): number {
  return Math.max(startedAt ?? 0, completedAt ?? fallbackCompletedAt ?? startedAt ?? 0)
}

export function elapsedTime(
  startedAt: number | undefined,
  completedAt: number | undefined,
  now: number,
): number {
  if (startedAt === undefined) return 0
  return Math.max(0, (completedAt ?? now) - startedAt)
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remaining = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

export function finalContentPreview(
  content: string,
  limit = FINAL_PREVIEW_CHAR_LIMIT,
): { content: string; hasMore: boolean } {
  const trimmed = content.trim()
  if (!trimmed) return { content: '', hasMore: false }
  const separator = /\r?\n\s*\r?\n/.exec(trimmed)
  const paragraphEnd = separator?.index ?? trimmed.length
  const safeLimit = Math.max(1, limit)
  const truncatedByLimit = paragraphEnd > safeLimit
  const previewEnd = truncatedByLimit ? safeLimit - 1 : paragraphEnd
  const preview = `${trimmed.slice(0, previewEnd).trimEnd()}${truncatedByLimit ? '…' : ''}`
  return {
    content: preview,
    hasMore: previewEnd < trimmed.length,
  }
}

export function firstParagraph(content: string): string {
  return finalContentPreview(content).content
}

function projectedStepStatus(
  status: ExecutionReadStep['status'],
  rootStatus: ExecutionRootStatus,
): ExecutionReadStep['status'] {
  if (status !== 'running') return status
  switch (rootStatus) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'paused':
    case 'cancelled':
      return 'cancelled'
    default:
      return status
  }
}

export function projectLiteExecution(
  model: ExecutionReadModel,
  now: number,
): LiteExecutionMonitorView {
  const running = model.status === 'running' || model.status === 'waiting'
  const terminal = !running && model.status !== 'idle'
  const startedAt = model.startedAt ?? model.currentQuestion?.createdAt
  const latestStepCompletion = model.steps.reduce<number | undefined>(
    (latest, step) =>
      step.completedAt === undefined ? latest : Math.max(latest ?? 0, step.completedAt),
    undefined,
  )
  const completedAt = !terminal
    ? undefined
    : terminalTime(
        startedAt,
        model.completedAt,
        model.finalResponse?.updatedAt ?? latestStepCompletion,
      )
  const steps = model.steps.map((step): LiteExecutionStepView => {
    const status = projectedStepStatus(step.status, model.status)
    const active = status === 'running' && !terminal
    const stepCompletedAt = active
      ? undefined
      : terminalTime(step.startedAt, step.completedAt, completedAt)
    return {
      key: executionStepKey(step),
      id: step.id,
      chatId: step.chatId,
      agentLabel: step.agentLabel,
      kind: step.kind,
      name: step.name || (step.kind === 'tool' ? '工具调用' : '模型响应'),
      status,
      startedAt: step.startedAt,
      ...(stepCompletedAt !== undefined ? { completedAt: stepCompletedAt } : {}),
      elapsedMs: elapsedTime(step.startedAt, stepCompletedAt, now),
      active,
      // The monitor deliberately keeps terminal steps to a one-line summary.
      expanded: active,
    }
  })

  const finalPreview = finalContentPreview(model.finalResponse?.content ?? '')
  return {
    question: model.currentQuestion?.content ?? '',
    status: model.status,
    statusLabel: STATUS_LABELS[model.status],
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    elapsedMs: elapsedTime(startedAt, completedAt, now),
    steps,
    activeSteps: steps.filter((step) => step.active),
    finalPreview: finalPreview.content,
    finalHasMore: finalPreview.hasMore,
    ...(model.finalResponse ? { finalResponseId: model.finalResponse.id } : {}),
  }
}

export interface LiteExecutionClock {
  now: Ref<number>
  start: () => void
  stop: () => void
  refresh: () => void
}

/** A presentation-only ticker. It never writes canonical execution state. */
export function createLiteExecutionClock(
  readNow: () => number = Date.now,
  intervalMs = 1000,
): LiteExecutionClock {
  const now = ref(readNow())
  let timer: ReturnType<typeof setInterval> | undefined

  const refresh = () => {
    now.value = readNow()
  }
  const start = () => {
    if (timer !== undefined) return
    refresh()
    timer = setInterval(refresh, intervalMs)
  }
  const stop = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  return { now, start, stop, refresh }
}
export type LiteRunNodeKind = 'user' | 'model' | 'tool'
export type LiteRunNodeStatus = 'running' | 'completed' | 'failed' | 'rejected' | 'cancelled'

/** 工具元信息（来自 sense.tools：中文名 label + 图标 icon）。 */
export interface LiteToolMeta {
  label: string
  icon: string
}
export type LiteToolMetaResolver = (name: string) => LiteToolMeta | undefined

/** 工具类型（时间瀑布流按类型配色）。 */
export type LiteToolType = 'exec' | 'read' | 'write' | 'web' | 'dispatch' | 'other'

/** 按工具原始名归类（启发式；未知回退 other）。 */
export function classifyToolType(name: string): LiteToolType {
  const key = (name ?? '').toLowerCase()
  if (
    key.startsWith('execute_command') ||
    /(^|_|\s)(bash|shell|exec|run|terminal|zsh|sh)($|[^a-z])/.test(key)
  )
    return 'exec'
  if (
    key.startsWith('spawn_role') ||
    key.startsWith('dispatch') ||
    /(^|_|\s)(delegate|spawn)($|[^a-z])/.test(key)
  )
    return 'dispatch'
  if (/(^|_|\s)(web|http|fetch|browse|url|website)($|[^a-z])/.test(key)) return 'web'
  if (
    key.startsWith('read_file') ||
    key.startsWith('search_codebase') ||
    key === 'glob' ||
    /(^|_|\s)(list|query|grep|search|get|read|find)($|[^a-z])/.test(key)
  )
    return 'read'
  if (
    /(^|_|\s)(write|edit|create|update|save|patch|delete|remove|rename|mkdir|install|config|append)($|[^a-z])/.test(
      key,
    )
  )
    return 'write'
  return 'other'
}

/** 工具类型 → emoji 标记（t15：工具小块「工具类型 emoji」）。 */
export const TOOL_TYPE_EMOJI: Record<LiteToolType, string> = {
  exec: '⚙️',
  read: '📖',
  write: '✍️',
  web: '🌐',
  dispatch: '📨',
  other: '🧩',
}
export function toolTypeEmoji(type: LiteToolType | undefined): string {
  return type ? (TOOL_TYPE_EMOJI[type] ?? '🧩') : '🧩'
}

export interface LiteRunNode {
  /** 稳定 key（含 nodeId 与顺序），列表渲染用 */
  key: string
  nodeId: string
  kind: LiteRunNodeKind
  /** 中文显示名（工具→中文名，模型→模型响应，用户→用户问题） */
  label: string
  /** 节点图标（cluster 小按钮 / 抽屉头部显示） */
  icon: string
  content: string
  /** 工具中文名（原名为 key，展示用 label） */
  toolNames: string[]
  status: LiteRunNodeStatus
  /** 正在运行（仅运行中的工具/模型节点为 true，见需求 2：未运行节点不做倒计时） */
  active: boolean
  startedAt: number
  completedAt?: number
  elapsedMs: number
  /** 轮次序号：每出现一条用户消息递增 */
  roundIndex: number
  /** 该轮次下的最后一条消息（用户消息与轮末消息保持展开，单独占一行） */
  isRoundFinal: boolean
  /** 极简折叠：非用户消息且非轮末消息 → 只显示消息本身，思考/正文收起 */
  collapsed: boolean
  /** 归属 Agent 的 chatId（时间瀑布流按此分轨） */
  sourceChatId: string
  /** 归属 Agent 显示名（主 Agent / 子 Agent 角色名） */
  agentLabel: string
  /** 工具类型（仅工具节点；按类型配色） */
  toolType?: LiteToolType
}

/** 一行布局：full=用户消息/轮末响应独占一行；cluster=多个中间节点（思考/工具）挤成一行的小按钮。 */
export interface LiteRunRow {
  kind: 'full' | 'cluster'
  node?: LiteRunNode
  nodes?: LiteRunNode[]
}

export interface LiteRunHistoryView {
  nodes: LiteRunNode[]
  rows: LiteRunRow[]
  running: boolean
}

/** 与 execution step 匹配的时间窗口：超过则视为无实时计时（旧轮次回退到节点时间）。 */
const STEP_MATCH_WINDOW_MS = 5 * 60_000

function isUserNode(node: TimelineNode): boolean {
  return node.kind === 'message' && node.actor?.kind === 'user'
}

function isModelNode(node: TimelineNode): boolean {
  return (
    node.kind === 'message' && node.actor?.kind === 'agent' && node.direction === 'agent-to-user'
  )
}

function isToolNode(node: TimelineNode): boolean {
  return node.kind === 'tool-batch'
}

function toolBatchStatus(calls: readonly GraphToolCall[] | undefined): LiteRunNodeStatus {
  const list = calls ?? []
  if (list.some((call) => call.status === 'pending' || call.status === 'accepted')) return 'running'
  if (list.some((call) => call.status === 'error')) return 'failed'
  if (list.some((call) => call.status === 'rejected')) return 'rejected'
  return 'completed'
}

function matchStep(
  stepsByChat: ReadonlyMap<string, readonly ExecutionStep[]>,
  chatId: string,
  refTime: number,
  kind: 'model' | 'tool',
): ExecutionStep | undefined {
  const candidates = stepsByChat.get(chatId)
  if (!candidates || candidates.length === 0) return undefined
  let best: ExecutionStep | undefined
  let bestDistance = Infinity
  for (const step of candidates) {
    if (step.kind !== kind) continue
    const distance = Math.abs(step.startedAt - refTime)
    if (distance < bestDistance) {
      bestDistance = distance
      best = step
    }
  }
  return best && bestDistance <= STEP_MATCH_WINDOW_MS ? best : undefined
}

/**
 * 运行历史投影：从开始节点往下，把用户问题、工具运行、大模型响应合并成
 * 一个按时间顺序的「关键节点」列表，供工作台极简视图上半部历史列表与
 * 详情抽屉的轨迹/折叠节点展示共用。
 *
 * - 轮次：每条根用户消息开启新轮；工具/模型节点归入其发生时的轮次。
 * - 折叠（需求 3d-1）：非用户消息且非轮末消息的节点折叠，只保留消息本身。
 * - 倒计时（需求 2）：仅运行中的工具节点 active；终态节点不再计算进行时耗时。
 * - 计时优先叠加 execution step 的实时事实，缺失时回退节点 createdAt/updatedAt。
 */
export function projectLiteHistory(
  nodes: readonly TimelineNode[],
  model: ExecutionReadModel,
  now: number,
  toolMeta?: LiteToolMetaResolver,
): LiteRunHistoryView {
  const toolMetaOf = (name: string): LiteToolMeta | undefined => toolMeta?.(name)
  const agentLabelByChat = new Map<string, string>()
  for (const agent of model.agents) agentLabelByChat.set(agent.chatId, agent.label)
  for (const step of model.steps) {
    if (!agentLabelByChat.has(step.chatId)) agentLabelByChat.set(step.chatId, step.agentLabel)
  }
  const agentLabelOf = (chatId: string): string => {
    const label = agentLabelByChat.get(chatId)
    if (label && label.trim()) return label
    return chatId === model.rootChatId ? '主 Agent' : '子 Agent'
  }
  const committed = nodes
    .filter((node) => node.status === 'committed')
    .slice()
    .sort((a, b) => a.orderKey - b.orderKey || a.id.localeCompare(b.id))

  const stepsByChat = new Map<string, ExecutionStep[]>()
  for (const step of model.steps) {
    const list = stepsByChat.get(step.chatId)
    if (list) list.push(step)
    else stepsByChat.set(step.chatId, [step])
  }

  interface PendingRun {
    node: TimelineNode
    run: LiteRunNode
    matchedStep?: ExecutionStep
  }
  const items: PendingRun[] = []
  const rounds: string[][] = [[]]
  let roundIndex = 0

  for (const node of committed) {
    let kind: LiteRunNodeKind | null = null
    if (isUserNode(node)) kind = 'user'
    else if (isModelNode(node)) kind = 'model'
    else if (isToolNode(node)) kind = 'tool'
    if (!kind) continue

    if (kind === 'user' && (rounds[roundIndex]?.length ?? 0) > 0) {
      roundIndex += 1
      rounds[roundIndex] ??= []
    }

    const toolCalls = node.toolCalls ?? []
    // 工具名一律使用中文名（sense.tools label），未命中回退原名（需求：所有工具调用必须使用中文名称）。
    const toolNames = toolCalls
      .map((call) => toolMetaOf(call.name)?.label?.trim() || call.name)
      .filter(Boolean)
    const toolIcons = toolCalls.map((call) => toolMetaOf(call.name)?.icon?.trim()).filter(Boolean)
    const matchedStep =
      kind === 'user'
        ? undefined
        : matchStep(
            stepsByChat,
            node.sourceChatId,
            node.createdAt,
            kind === 'tool' ? 'tool' : 'model',
          )
    const base: LiteRunNode = {
      key: `${node.id}:${node.orderKey}`,
      nodeId: node.id,
      kind,
      label:
        kind === 'user'
          ? '用户问题'
          : kind === 'tool'
            ? toolNames.join(', ') || '工具执行'
            : '模型响应',
      icon: kind === 'user' ? '❯' : kind === 'tool' ? (toolIcons[0] ?? '⚙') : '✧',
      content: kind === 'user' || kind === 'model' ? node.content : '',
      toolNames,
      sourceChatId: node.sourceChatId,
      agentLabel: agentLabelOf(node.sourceChatId),
      ...(kind === 'tool' ? { toolType: classifyToolType(toolCalls[0]?.name ?? '') } : {}),
      status: 'completed',
      active: false,
      startedAt: node.createdAt,
      ...(node.updatedAt !== undefined ? { completedAt: node.updatedAt } : {}),
      elapsedMs: 0,
      roundIndex,
      isRoundFinal: false,
      collapsed: true,
    }
    const pending: PendingRun = { node, run: base, matchedStep }
    items.push(pending)
    const roundKeys = (rounds[roundIndex] ??= [])
    roundKeys.push(base.key)
  }

  const finalKeys = new Set<string>()
  for (const keys of rounds) {
    const last = keys.at(-1)
    if (last) finalKeys.add(last)
  }
  const rootRunning = model.status === 'running' || model.status === 'waiting'

  const nodesOut = items.map(({ node, run, matchedStep }): LiteRunNode => {
    const isFinal = finalKeys.has(run.key)
    const next: LiteRunNode = { ...run, isRoundFinal: isFinal }
    if (matchedStep) {
      const active = matchedStep.status === 'running' && rootRunning
      next.status =
        matchedStep.status === 'running' ? (active ? 'running' : 'completed') : matchedStep.status
      next.active = active
      next.startedAt = matchedStep.startedAt
      if (active) {
        delete next.completedAt
        next.elapsedMs = elapsedTime(matchedStep.startedAt, undefined, now)
      } else {
        next.completedAt = matchedStep.completedAt
        next.elapsedMs = elapsedTime(matchedStep.startedAt, next.completedAt, now)
      }
      return next
    }
    // 无实时 step 回退：仅运行中的节点以 now 计时（需求 2），终态节点用固定耗时。
    if (run.kind === 'tool') {
      const status = toolBatchStatus(node.toolCalls)
      const active = status === 'running' && rootRunning
      next.status = active ? 'running' : status
      next.active = active
      next.startedAt = node.createdAt
      if (!active) {
        next.completedAt = node.updatedAt
        next.elapsedMs = Math.max(0, node.updatedAt - node.createdAt)
      } else {
        delete next.completedAt
        next.elapsedMs = Math.max(0, now - node.createdAt)
      }
      return next
    }
    // 用户消息 / 模型响应：committed 即终态，耗时 = updatedAt - createdAt。
    next.startedAt = node.createdAt
    next.completedAt = node.updatedAt
    next.elapsedMs = Math.max(0, node.updatedAt - node.createdAt)
    return next
  })

  // 需求 3 收尾（进行中节点）：turn.started / sense_started 在回合末才 commit，timeline 尚无
  // 已提交节点。用 executionReadModel.steps 中 status==='running' 且未被任何已提交节点匹配的
  // step 合成「进行中节点」：占位 bar + 实时计时 + 可点击；回合完成 step 转终态后占位消失，
  // 已提交节点自然接管（并入）。
  const matchedStepIds = new Set<string>()
  for (const item of items) {
    if (item.matchedStep) matchedStepIds.add(item.matchedStep.id)
  }
  const currentRound = Math.max(0, rounds.length - 1)
  for (const step of model.steps) {
    if (step.status !== 'running' || matchedStepIds.has(step.id)) continue
    const isModel = step.kind === 'model'
    const toolLabel = toolMetaOf(step.name)?.label?.trim()
    nodesOut.push({
      key: `inflight:${step.id}`,
      nodeId: `inflight:${step.id}`,
      kind: isModel ? 'model' : 'tool',
      label: isModel ? '正在生成回答…' : toolLabel || step.name || '工具执行',
      icon: isModel ? '✧' : toolMetaOf(step.name)?.icon?.trim() || '⚙',
      content: '',
      toolNames: isModel ? [] : [toolLabel || step.name].filter(Boolean),
      ...(!isModel ? { toolType: classifyToolType(step.name) } : {}),
      status: 'running',
      active: rootRunning,
      startedAt: step.startedAt,
      elapsedMs: elapsedTime(step.startedAt, undefined, now),
      roundIndex: currentRound,
      isRoundFinal: isModel,
      collapsed: !isModel,
      sourceChatId: step.chatId,
      agentLabel: agentLabelOf(step.chatId),
    })
  }
  nodesOut.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key))

  for (const run of nodesOut) {
    run.collapsed = !(run.kind === 'user' || run.isRoundFinal)
  }

  // 行布局（需求 4a）：用户消息与轮末响应单独占一行；中间的思考/工具节点
  // 挤成一个 cluster 小按钮行（可换行），不单独占行。
  const rows: LiteRunRow[] = []
  let cluster: LiteRunNode[] = []
  const flushCluster = () => {
    if (cluster.length > 0) {
      rows.push({ kind: 'cluster', nodes: cluster })
      cluster = []
    }
  }
  for (const run of nodesOut) {
    if (run.kind === 'user' || run.isRoundFinal) {
      flushCluster()
      rows.push({ kind: 'full', node: run })
    } else {
      cluster.push(run)
    }
  }
  flushCluster()

  return { nodes: nodesOut, rows, running: rootRunning }
}
