import { ref, type Ref } from 'vue'
import type {
  ExecutionReadModel,
  ExecutionReadStep,
  ExecutionRootStatus,
} from '@/stores/chats/executionReadModel'
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
