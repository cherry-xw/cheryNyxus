import { getRecentChatEvents } from '@/db/delivery.js'
import { approvalManager } from '../approval/manager.js'
import { getActiveChatRunId, isChatRunning } from './runtime.js'
import { safeJsonParse } from '@/utils/json.js'
import type { StoredChatEvent } from '@/db/delivery.js'
import type { CurrentStateData, ExecutionStep } from '../message/types.js'
import type { ToolAuthorization } from '@/core/security/rolePolicy.js'

const CURRENT_RUN_EVENT_LIMIT = 10_000

function eventRunId(event: Record<string, unknown>, data: Record<string, unknown>): string | undefined {
  return typeof data.runId === 'string'
    ? data.runId
    : typeof event.runId === 'string'
      ? event.runId
      : undefined
}

/** 从持久 run.updated 重建当前活动 run 的开始时间。 */
function rebuildRunTiming(
  events: StoredChatEvent[],
  activeRunId: string | undefined,
): CurrentStateData['runTiming'] {
  if (!activeRunId) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as Record<string, unknown>
    const data = (event.data ?? {}) as Record<string, unknown>
    if (
      event.kind !== 'notification' ||
      event.type !== 'run.updated' ||
      data.status !== 'running' ||
      eventRunId(event, data) !== activeRunId
    ) {
      continue
    }
    const startedAt =
      typeof data.startedAt === 'number'
        ? data.startedAt
        : typeof data.at === 'number'
          ? data.at
          : undefined
    if (startedAt !== undefined) return { runId: activeRunId, startedAt }
  }
  return undefined
}

/** 活动步骤优先，再用最新终态步骤填满严格数量预算；活动超限时保留最新项。 */
export function limitExecutionSteps(
  steps: ExecutionStep[],
  limit?: number,
): ExecutionStep[] {
  const chronological = [...steps].sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  )
  if (limit === undefined || chronological.length <= limit) return chronological
  const effectiveLimit = Math.max(0, Math.floor(limit))
  if (effectiveLimit === 0) return []
  const running = chronological
    .filter((step) => step.status === 'running')
    .slice(-effectiveLimit)
  const remaining = effectiveLimit - running.length
  const terminal = chronological
    .filter((step) => step.status !== 'running')
    .sort(
      (a, b) =>
        (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt) ||
        b.id.localeCompare(a.id),
    )
    .slice(0, remaining)
  return [...running, ...terminal].sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  )
}

/** 从持久事件重建该 chat 最近一次 run 的模型与工具计时步骤。 */
function rebuildExecutionSteps(
  chatId: string,
  events: StoredChatEvent[],
  limit?: number,
): ExecutionStep[] {
  let currentRunId: string | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as Record<string, unknown>
    const data = (event.data ?? {}) as Record<string, unknown>
    if (
      event.kind === 'notification' &&
      event.type === 'run.updated' &&
      data.status === 'running'
    ) {
      currentRunId = eventRunId(event, data)
      if (currentRunId) break
    }
  }
  if (!currentRunId) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] as Record<string, unknown>
      const data = (event.data ?? {}) as Record<string, unknown>
      currentRunId = eventRunId(event, data)
      if (currentRunId) break
    }
  }
  if (!currentRunId) return []

  const steps = new Map<string, ExecutionStep>()
  let runHadError = false

  for (const stored of events) {
    const event = stored as Record<string, unknown>
    if (event.kind !== 'notification') continue
    const type = event.type
    const data = (event.data ?? {}) as Record<string, unknown>
    if (eventRunId(event, data) !== currentRunId) continue

    if (
      type === 'turn.started' &&
      typeof data.turnId === 'string' &&
      typeof data.createdAt === 'number'
    ) {
      steps.set(`model:${data.turnId}`, {
        id: data.turnId,
        runId: currentRunId,
        chatId,
        kind: 'model',
        name: '模型响应',
        status: 'running',
        startedAt: data.createdAt,
      })
      continue
    }

    if (type === 'turn.completed' && typeof data.turnId === 'string') {
      const key = `model:${data.turnId}`
      const step = steps.get(key)
      if (step && typeof data.completedAt === 'number') {
        steps.set(key, { ...step, status: 'completed', completedAt: data.completedAt })
      }
      continue
    }

    if (
      type === 'sense_started' &&
      typeof data.id === 'string' &&
      typeof data.startedAt === 'number'
    ) {
      steps.set(`tool:${data.id}`, {
        id: data.id,
        runId: currentRunId,
        chatId,
        kind: 'tool',
        name: typeof data.senseName === 'string' ? data.senseName : '',
        status: 'running',
        startedAt: data.startedAt,
      })
      continue
    }

    if ((type === 'accept' || type === 'rejected') && typeof data.approvalId === 'string') {
      const completedAt = typeof data.completedAt === 'number' ? data.completedAt : undefined
      if (completedAt === undefined) continue
      const key = `tool:${data.approvalId}`
      const existing = steps.get(key)
      const failed =
        type === 'accept' &&
        typeof data.result === 'string' &&
        data.result.startsWith('感官执行失败：')
      steps.set(key, {
        ...(existing ?? {
          id: data.approvalId,
          runId: currentRunId,
          chatId,
          kind: 'tool' as const,
          name: typeof data.senseName === 'string' ? data.senseName : '',
          // 未进入真实执行边界的拒绝步骤耗时为 0，不把审批等待计入工具执行时间。
          startedAt: completedAt,
        }),
        status: type === 'rejected' ? 'rejected' : failed ? 'failed' : 'completed',
        completedAt,
      })
      continue
    }

    if (type === 'error') {
      runHadError = true
      continue
    }

    if (type === 'run.updated' && typeof data.at === 'number') {
      const status = data.status
      if (status !== 'paused' && status !== 'completed' && status !== 'failed') continue
      for (const [key, step] of steps) {
        if (step.status !== 'running') continue
        steps.set(key, {
          ...step,
          status:
            status === 'completed'
              ? 'completed'
              : status === 'failed' || runHadError
                ? 'failed'
                : 'cancelled',
          completedAt: data.at,
        })
      }
    }
  }

  return limitExecutionSteps([...steps.values()], limit)
}

/**
 * 计算刷新当前态快照（G8）。扫描近期 chat 事件 + 内存审批态，权威给出：
 * - pendingApproval：仍存活的挂起审批（approvalManager 内存命中）。park 不发 rejected 事件，
 *   故「审批是否仍可审批」只能靠内存判定，事件流推导不可靠。
 * - runningTools：已发 sense_end/sense_started 但无 accept/rejected 的工具（含待审批）。
 * - currentTodo：最近一条 update_todo 的结构化 todos（todo 无专用通知，靠 sense_end.arguments）。
 *
 * 事件流（chat.sync）仍是前端缓存数组的累积水源；本快照仅补事件无法可靠判定的事实。
 * 不含 currentTurnContent：当前轮 content 由事件流（stream delta + content_end）累积重建，
 * 快照会造成双内容源合并，违背单一缓存数组原则。
 */
export function computeCurrentState(
  chatId: string,
  options: { executionStepLimit?: number } = {},
): CurrentStateData {
  const events = getRecentChatEvents(chatId, CURRENT_RUN_EVENT_LIMIT)
  const running = isChatRunning(chatId)
  const activeRunId = getActiveChatRunId(chatId)

  type InterruptInfo = {
    approvalId: string
    senseName: string
    arguments: string
    supervisionLevel: number
    waitTime: number
    createdAt: number
    security?: ToolAuthorization
  }

  // 迭代近期事件（升序）：跟踪最近未决 interrupt + 未决 sense 调用 + 最近 todo
  let pendingInterrupt: InterruptInfo | undefined
  const runningToolsMap = new Map<string, { id: string; senseName: string }>()
  let currentTodo: unknown[] | undefined

  for (const ev of events) {
    const e = ev as Record<string, unknown>
    const kind = e.kind
    const type = e.type
    const data = (e.data ?? {}) as Record<string, unknown>

    if (kind === 'notification') {
      if (type === 'interrupt') {
        const id = data.approvalId as string | undefined
        if (id) {
          pendingInterrupt = {
            approvalId: id,
            senseName: (data.senseName as string) ?? '',
            arguments: (data.arguments as string) ?? '',
            supervisionLevel: (data.supervisionLevel as number) ?? 1,
            waitTime: (data.waitTime as number) ?? 0,
            createdAt: (data.createdAt as number) ?? 0,
            security: data.security as ToolAuthorization | undefined,
          }
          runningToolsMap.set(id, { id, senseName: (data.senseName as string) ?? '' })
        }
      } else if (type === 'accept' || type === 'rejected') {
        const id = data.approvalId as string | undefined
        if (id) {
          runningToolsMap.delete(id)
          if (pendingInterrupt?.approvalId === id) pendingInterrupt = undefined
        }
      } else if (type === 'sense_started') {
        // auto 工具运行信号（id 与 accept.approvalId 同源，accept 时移除）
        const id = data.id as string | undefined
        if (id) runningToolsMap.set(id, { id, senseName: (data.senseName as string) ?? '' })
      }
    } else if (kind === 'chunk' && type === 'staged') {
      if (data.type === 'sense_end') {
        const id = data.id as string | undefined
        const senseName = (data.senseName as string) ?? ''
        if (id) runningToolsMap.set(id, { id, senseName })
        if (senseName === 'update_todo') {
          const parsed = safeJsonParse<{ todos?: unknown[] }>((data.arguments as string) ?? '', {})
          if (Array.isArray(parsed?.todos)) currentTodo = parsed.todos
        }
      }
    }
  }

  // pendingApproval：仅当仍存活（未被 confirm/park/hard-timeout/超时清出）
  const pendingApproval =
    pendingInterrupt && approvalManager.has(pendingInterrupt.approvalId)
      ? pendingInterrupt
      : undefined

  // runningTools：仅 run 在跑时有意义（idle/parked 时无运行中工具）
  const runningTools = running ? Array.from(runningToolsMap.values()) : []

  const result: CurrentStateData = {
    runningTools,
    executionSteps: rebuildExecutionSteps(chatId, events, options.executionStepLimit),
  }
  const runTiming = rebuildRunTiming(events, activeRunId)
  if (runTiming) result.runTiming = runTiming
  if (pendingApproval) result.pendingApproval = pendingApproval
  if (currentTodo) result.currentTodo = currentTodo
  return result
}
