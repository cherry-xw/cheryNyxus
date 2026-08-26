import type {
  ActiveRunFact,
  ExecutionStep,
  RootTimelineSnapshot,
  RunSnapshot,
  TimelineNode,
} from '@/services/agentApi'
import type { ChatMessage, ChatSession } from '../types'
import type { RootTimelineTransientState } from './rootTimeline'
import { executionStepKey } from './executionTiming'

export interface ExecutionPresentationOptions {
  stream: 'full' | 'final-only'
  content: 'full' | 'summary' | 'lazy'
  toolDetail: 'full' | 'name-only' | 'lazy'
  thinking: 'full' | 'lazy' | 'omitted'
  executionStepLimit?: number
  timelinePageSize?: number
  detailPageChars?: number
}

export const FULL_EXECUTION_PRESENTATION: Readonly<ExecutionPresentationOptions> = Object.freeze({
  stream: 'full',
  content: 'full',
  toolDetail: 'full',
  thinking: 'full',
})

export const LITE_EXECUTION_PRESENTATION: Readonly<ExecutionPresentationOptions> = Object.freeze({
  stream: 'final-only',
  content: 'lazy',
  toolDetail: 'name-only',
  thinking: 'lazy',
})

export type ExecutionRootStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ExecutionQuestion {
  id: string
  content: string
  createdAt: number
}

export interface ExecutionFinalResponse {
  id: string
  content: string
  thinking?: string
  createdAt: number
  updatedAt: number
}

export interface ExecutionReadStep extends ExecutionStep {
  isRoot: boolean
  agentLabel: string
}

export interface ExecutionAgentActivity {
  chatId: string
  label: string
  isRoot: boolean
  status: ExecutionRootStatus
  startedAt?: number
  completedAt?: number
  stepIds: string[]
}

export interface ExecutionReadModel {
  rootChatId: string
  currentQuestion?: ExecutionQuestion
  status: ExecutionRootStatus
  runId?: string
  startedAt?: number
  completedAt?: number
  steps: ExecutionReadStep[]
  agents: ExecutionAgentActivity[]
  finalResponse?: ExecutionFinalResponse
}

export interface ExecutionReadModelSource {
  rootChatId: string
  sessionsById: Readonly<Record<string, ChatSession>>
  timeline?: RootTimelineSnapshot
  transient?: RootTimelineTransientState
}

interface OrderedQuestion extends ExecutionQuestion {
  orderKey: number
}

interface OrderedFinalResponse extends ExecutionFinalResponse {
  orderKey: number
}

type ReadRunFact = RunSnapshot | ActiveRunFact

function belongsToRoot(
  chatId: string,
  rootChatId: string,
  sessionsById: Readonly<Record<string, ChatSession>>,
): boolean {
  let current: string | undefined = chatId
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    if (current === rootChatId) return true
    seen.add(current)
    current = sessionsById[current]?.meta.parentChatId ?? undefined
  }
  return false
}

function belongsToSourceRoot(chatId: string, source: ExecutionReadModelSource): boolean {
  if (chatId === source.rootChatId) return true
  if (source.transient?.observedChatIds.has(chatId)) return true
  if (
    source.timeline?.rootChatId === source.rootChatId &&
    (source.timeline.activeRuns.some((run) => run.chatId === chatId) ||
      source.timeline.nodes.some((node) => node.sourceChatId === chatId))
  ) {
    return true
  }
  return belongsToRoot(chatId, source.rootChatId, source.sessionsById)
}

function isRootUserNode(node: TimelineNode, rootChatId: string): boolean {
  return (
    node.rootChatId === rootChatId &&
    node.sourceChatId === rootChatId &&
    node.status === 'committed' &&
    node.kind === 'message' &&
    node.actor.kind === 'user' &&
    node.direction === 'user-to-agent' &&
    node.visibility !== 'internal' &&
    (!node.target || (node.target.kind === 'agent' && node.target.chatId === rootChatId))
  )
}

function isRootFinalNode(node: TimelineNode, rootChatId: string): boolean {
  return (
    node.rootChatId === rootChatId &&
    node.sourceChatId === rootChatId &&
    node.status === 'committed' &&
    node.kind === 'message' &&
    node.actor.kind === 'agent' &&
    node.actor.chatId === rootChatId &&
    node.direction === 'agent-to-user' &&
    node.visibility === 'conversation' &&
    (!node.target || node.target.kind === 'user')
  )
}

function selectTimelineQuestion(
  timeline: RootTimelineSnapshot | undefined,
  rootChatId: string,
): OrderedQuestion | undefined {
  const node = timeline?.nodes
    .filter((item) => isRootUserNode(item, rootChatId))
    .sort((a, b) => a.orderKey - b.orderKey || a.id.localeCompare(b.id))
    .at(-1)
  return node
    ? { id: node.sourceMessageId ?? node.id, content: node.content, createdAt: node.createdAt, orderKey: node.orderKey }
    : undefined
}

function selectSessionQuestion(session: ChatSession | undefined): OrderedQuestion | undefined {
  if (!session) return undefined
  const message = Object.values(session.messagesById)
    .filter(
      (item): item is ChatMessage =>
        item.role === 'user' &&
        item.status !== 'revoked' &&
        item.agentChatId === session.chatId,
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.msgId.localeCompare(b.msgId))
    .at(-1)
  return message
    ? {
        id: message.msgId,
        content: message.content,
        createdAt: message.createdAt,
        orderKey: message.createdAt,
      }
    : undefined
}

function selectQuestion(source: ExecutionReadModelSource): OrderedQuestion | undefined {
  const committed =
    selectTimelineQuestion(source.timeline, source.rootChatId) ??
    selectSessionQuestion(source.sessionsById[source.rootChatId])
  const inputs = source.transient?.pendingInputs ?? source.sessionsById[source.rootChatId]?.pendingInputs ?? []
  const committedMessageIds = new Set(
    source.timeline?.nodes
      .filter((node) => node.sourceChatId === source.rootChatId && node.sourceMessageId)
      .map((node) => node.sourceMessageId as string) ?? [],
  )
  const pending = inputs
    .filter(
      (input) =>
        (input.chatId === undefined || input.chatId === source.rootChatId) &&
        input.state !== 'queued' &&
        input.state !== 'cancelled' &&
        input.state !== 'rejected' &&
        !!input.content &&
        (!input.messageId || !committedMessageIds.has(input.messageId)),
    )
    .map((input) => ({
      id: input.messageId ?? input.inputId,
      content: input.content,
      createdAt: input.acceptedAt ?? input.createdAt ?? 0,
      orderKey: committed?.orderKey ?? -Infinity,
    }))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .at(-1)
  return pending && pending.createdAt >= (committed?.createdAt ?? -Infinity) ? pending : committed
}

function selectTimelineFinal(
  timeline: RootTimelineSnapshot | undefined,
  rootChatId: string,
  afterOrderKey: number,
  afterCreatedAt: number,
): OrderedFinalResponse | undefined {
  const node = timeline?.nodes
    .filter(
      (item) =>
        isRootFinalNode(item, rootChatId) &&
        item.orderKey > afterOrderKey &&
        item.createdAt >= afterCreatedAt,
    )
    .sort((a, b) => a.orderKey - b.orderKey || a.id.localeCompare(b.id))
    .at(-1)
  return node
    ? {
        id: node.sourceMessageId ?? node.id,
        content: node.content,
        ...(node.thinking ? { thinking: node.thinking } : {}),
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        orderKey: node.orderKey,
      }
    : undefined
}

function selectSessionFinal(
  session: ChatSession | undefined,
  afterCreatedAt: number,
): OrderedFinalResponse | undefined {
  if (!session) return undefined
  const message = Object.values(session.messagesById)
    .filter(
      (item): item is ChatMessage =>
        item.role === 'assistant' &&
        item.status === 'sealed' &&
        item.agentChatId === session.chatId &&
        item.createdAt >= afterCreatedAt,
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.msgId.localeCompare(b.msgId))
    .at(-1)
  return message
    ? {
        id: message.msgId,
        content: message.content,
        ...(message.thinking ? { thinking: message.thinking } : {}),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        orderKey: message.createdAt,
      }
    : undefined
}

function runStatus(run: ReadRunFact | undefined): ExecutionRootStatus | undefined {
  const status = run && ('status' in run ? run.status : undefined)
  const normalized = status ?? (run && 'state' in run ? run.state : undefined)
  return normalized === 'running' || normalized === 'waiting' || normalized === 'paused' ||
    normalized === 'completed' || normalized === 'failed'
    ? normalized
    : normalized === 'cancelled'
      ? 'cancelled'
      : undefined
}

function runTime(
  run: ReadRunFact | undefined,
  field: 'startedAt' | 'completedAt' | 'at',
): number | undefined {
  const value = (run as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'number' ? value : undefined
}

function mergeRun(current: ReadRunFact | undefined, incoming: ReadRunFact): ReadRunFact {
  if (!current || current.runId !== incoming.runId) return { ...incoming }
  return { ...current, ...incoming }
}

function selectRunFacts(source: ExecutionReadModelSource): Map<string, ReadRunFact> {
  const runs = new Map<string, ReadRunFact>()
  for (const run of source.timeline?.activeRuns ?? []) runs.set(run.chatId, { ...run })
  for (const session of Object.values(source.sessionsById)) {
    if (!belongsToSourceRoot(session.chatId, source)) continue
    const run = session.activeRun
    if (!run) continue
    const current = runs.get(session.chatId)
    if (!current || current.runId !== run.runId || !runStatus(current)) {
      runs.set(session.chatId, mergeRun(current, { ...run, chatId: session.chatId }))
    } else {
      runs.set(session.chatId, { ...run, ...current, chatId: session.chatId })
    }
  }
  for (const run of source.transient?.runStates ?? []) {
    if (!run.chatId) continue
    runs.set(run.chatId, mergeRun(runs.get(run.chatId), run))
  }
  return runs
}

function selectSteps(source: ExecutionReadModelSource, startedAt: number | undefined): ExecutionReadStep[] {
  const steps = new Map<string, ExecutionStep>()
  const observed = source.transient?.observedChatIds ?? new Set<string>()
  for (const session of Object.values(source.sessionsById)) {
    if (!belongsToSourceRoot(session.chatId, source)) continue
    if (observed.has(session.chatId)) continue
    for (const step of session.executionSteps) steps.set(executionStepKey(step), { ...step })
  }
  for (const step of source.transient?.executionSteps ?? []) {
    if (!belongsToSourceRoot(step.chatId, source)) continue
    steps.set(executionStepKey(step), { ...step })
  }
  return [...steps.values()]
    .filter((step) => startedAt === undefined || step.startedAt >= startedAt)
    .sort(
      (a, b) => a.startedAt - b.startedAt || executionStepKey(a).localeCompare(executionStepKey(b)),
    )
    .map((step) => ({
      ...step,
      isRoot: step.chatId === source.rootChatId,
      agentLabel: agentLabel(step.chatId, source),
    }))
}

function agentLabel(chatId: string, source: ExecutionReadModelSource): string {
  if (chatId === source.rootChatId) return '主 Agent'
  return source.sessionsById[chatId]?.meta.agentType ?? '子 Agent'
}

function latestTime(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number')
  return present.length ? Math.max(...present) : undefined
}

function earliestTime(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number')
  return present.length ? Math.min(...present) : undefined
}

function deriveOverallStatus(
  rootRun: ReadRunFact | undefined,
  runs: Iterable<ReadRunFact>,
  steps: readonly ExecutionReadStep[],
  hasFinal: boolean,
): ExecutionRootStatus {
  const statuses = [...runs].map(runStatus)
  if (statuses.includes('running') || steps.some((step) => step.status === 'running')) return 'running'
  if (statuses.includes('waiting')) return 'waiting'
  const rootStatus = runStatus(rootRun)
  if (rootStatus) return rootStatus
  if (statuses.includes('failed') || steps.some((step) => step.status === 'failed')) return 'failed'
  if (statuses.includes('paused') || steps.some((step) => step.status === 'cancelled')) return 'paused'
  if (hasFinal || steps.length > 0) return 'completed'
  return 'idle'
}

function agentStatus(run: ReadRunFact | undefined, steps: readonly ExecutionReadStep[]): ExecutionRootStatus {
  if (steps.some((step) => step.status === 'running')) return 'running'
  const status = runStatus(run)
  if (status) return status
  if (steps.some((step) => step.status === 'failed')) return 'failed'
  if (steps.some((step) => step.status === 'cancelled')) return 'cancelled'
  return steps.length ? 'completed' : 'idle'
}

function selectAgents(
  source: ExecutionReadModelSource,
  runs: Map<string, ReadRunFact>,
  steps: readonly ExecutionReadStep[],
): ExecutionAgentActivity[] {
  const chatIds = new Set<string>([source.rootChatId, ...runs.keys(), ...steps.map((step) => step.chatId)])
  return [...chatIds]
    .filter((chatId) => belongsToSourceRoot(chatId, source))
    .map((chatId) => {
      const run = runs.get(chatId)
      const ownSteps = steps.filter((step) => step.chatId === chatId)
      const startedAt = earliestTime([
        runTime(run, 'startedAt'),
        ...ownSteps.map((step) => step.startedAt),
      ])
      const completedAt = latestTime([
        runTime(run, 'completedAt'),
        runTime(run, 'at'),
        ...ownSteps.map((step) => step.completedAt),
      ])
      return {
        chatId,
        label: agentLabel(chatId, source),
        isRoot: chatId === source.rootChatId,
        status: agentStatus(run, ownSteps),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
        stepIds: ownSteps.map((step) => executionStepKey(step)),
      }
    })
    .sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.chatId.localeCompare(b.chatId))
}

/** Pure projection shared by the complete workbench and Lite presentation. */
export function selectExecutionReadModel(source: ExecutionReadModelSource): ExecutionReadModel {
  const question = selectQuestion(source)
  const runs = selectRunFacts(source)
  const rootRun = runs.get(source.rootChatId)
  const provisionalStartedAt =
    question?.createdAt ??
    earliestTime([
      runTime(rootRun, 'startedAt'),
      ...[...runs.values()].map((run) => runTime(run, 'startedAt')),
    ])
  const steps = selectSteps(source, provisionalStartedAt)
  const terminalCandidate =
    selectTimelineFinal(
      source.timeline,
      source.rootChatId,
      question?.orderKey ?? -Infinity,
      question?.createdAt ?? -Infinity,
    ) ??
    selectSessionFinal(source.sessionsById[source.rootChatId], question?.createdAt ?? -Infinity)
  const status = deriveOverallStatus(rootRun, runs.values(), steps, !!terminalCandidate)
  const finalResponse = status === 'completed' ? terminalCandidate : undefined
  const startedAt =
    provisionalStartedAt ?? earliestTime(steps.map((step) => step.startedAt))
  const completedAt =
    status === 'running' || status === 'waiting' || status === 'idle'
      ? undefined
      : latestTime([
          runTime(rootRun, 'completedAt'),
          runTime(rootRun, 'at'),
          finalResponse?.updatedAt,
          ...steps.map((step) => step.completedAt),
        ])

  return {
    rootChatId: source.rootChatId,
    ...(question
      ? {
          currentQuestion: {
            id: question.id,
            content: question.content,
            createdAt: question.createdAt,
          },
        }
      : {}),
    status,
    ...(rootRun?.runId ? { runId: rootRun.runId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    steps,
    agents: selectAgents(source, runs, steps),
    ...(finalResponse
      ? {
          finalResponse: {
            id: finalResponse.id,
            content: finalResponse.content,
            ...(finalResponse.thinking ? { thinking: finalResponse.thinking } : {}),
            createdAt: finalResponse.createdAt,
            updatedAt: finalResponse.updatedAt,
          },
        }
      : {}),
  }
}
