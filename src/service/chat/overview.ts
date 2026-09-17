import { randomUUID } from 'crypto'
import { getRootChatId, listAllChats } from '@/db/chat.js'
import { listPendingInteractionsForRoots } from '@/db/interaction.js'
import { onPreparedChatEvent, type DeliverableChatEvent } from '@/db/delivery.js'
import { safeJsonParse } from '@/utils/json.js'
import { computeCanResume } from './canResume.js'
import { computeCurrentState } from './currentState.js'
import { isChatRunning } from './runtime.js'
import { createNotification, Method } from '../message/types.js'
import {
  projectTaskCatalogItemByChat,
  onTaskResultViewChanged,
  taskFamilyForChat,
  taskKeyForChat,
} from './taskCatalog.js'
import type {
  ChatOverviewCloseRequestData,
  ChatOverviewCloseResponseData,
  ChatOverviewOpenRequestData,
  ChatOverviewOpenResponseData,
  TaskActivityEvent,
  TaskAgentOverview,
  TaskOverview,
} from '../message/types.js'
import type { HandlerContext, RpcRouter } from '../message/router.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'

const RECENT_EVENT_LIMIT = 20
const recentEvents = new Map<string, TaskActivityEvent[]>()
const subscriptions = new Map<
  string,
  { connectionId: string; completedSince: number; revision: number }
>()

connectionManager.onClose((connectionId) => {
  for (const [id, subscription] of subscriptions) {
    if (subscription.connectionId === connectionId) subscriptions.delete(id)
  }
})

type ChatMetadata = {
  preset?: string
  presetId?: string
  type?: string
  finished?: boolean
}

function metadataOf(raw: string | null): ChatMetadata {
  return raw ? safeJsonParse<ChatMetadata>(raw, {}) : {}
}

function agentOverview(
  chat: ReturnType<typeof listAllChats>[number],
  pendingChatIds: ReadonlySet<string>,
): TaskAgentOverview {
  const metadata = metadataOf(chat.metadata)
  const running = isChatRunning(chat.id)
  const current = computeCurrentState(chat.id, { executionStepLimit: 20 })
  const activeStep = [...(current.executionSteps ?? [])]
    .reverse()
    .find((step) => step.status === 'running')
  const lastStep = current.executionSteps?.at(-1)
  const failed = !running && lastStep?.status === 'failed'
  const resumable = !running && !metadata.finished && computeCanResume(chat.id)
  const status: TaskAgentOverview['status'] = pendingChatIds.has(chat.id)
    ? 'needs_user'
    : running
      ? 'running'
      : failed
        ? 'failed'
        : resumable
          ? 'paused'
          : metadata.finished
            ? 'completed'
            : 'idle'
  return {
    chatId: chat.id,
    role: chat.parent_chat_id ? metadata.type || '子 Agent' : '主 Agent',
    status,
    ...(activeStep
      ? {
          currentStep: activeStep.kind === 'model' ? '思考中' : activeStep.name || '执行工具',
          // 节点类型透出（标题栏会话状态条 icon 按此映射：model=思考动画 / tool=sense 图标）。
          currentStepKind: activeStep.kind,
        }
      : {}),
    ...(current.runTiming?.startedAt ? { startedAt: current.runTiming.startedAt } : {}),
  }
}

export function buildTaskOverview(
  rootChatId: string,
  completedSince = Date.now(),
): TaskOverview | undefined {
  const family = taskFamilyForChat(rootChatId)
  const catalog = projectTaskCatalogItemByChat(rootChatId)
  if (!family || !catalog) return undefined
  const rows = family.rows
  const branchRootIds = family.branchRoots.length
    ? family.branchRoots.map((branch) => branch.chatId)
    : [family.originalChatId]
  const pending = listPendingInteractionsForRoots(branchRootIds)
  const pendingChatIds = new Set(pending.map((item) => item.chatId))
  const agents = rows.map((row) => agentOverview(row, pendingChatIds))
  const hasFailure = agents.some((agent) => agent.status === 'failed')
  const activity = recentEvents.get(family.taskKey) ?? []
  const updatedAt = Math.max(catalog.updatedAt, ...(activity.length ? [activity.at(-1)!.at] : []))
  if ((catalog.status === 'completed' || catalog.status === 'idle') && updatedAt < completedSince) {
    return undefined
  }
  const rootMeta = metadataOf(family.original.metadata)
  const activeStarted = agents.flatMap((agent) => (agent.startedAt ? [agent.startedAt] : []))
  return {
    rootChatId: family.taskKey,
    taskKey: family.taskKey,
    ...(family.taskId ? { taskId: family.taskId } : {}),
    ...(rootMeta.presetId ? { presetId: rootMeta.presetId } : {}),
    ...(rootMeta.preset ? { preset: rootMeta.preset } : {}),
    title: catalog.title,
    ...(catalog.lastUserPrompt ? { lastUserPrompt: catalog.lastUserPrompt } : {}),
    status: catalog.status,
    startedAt: activeStarted.length ? Math.min(...activeStarted) : family.original.created_at,
    updatedAt,
    pendingCount: pending.length,
    hasFailure,
    agents,
    recentEvents: [...activity],
    originalChatId: family.originalChatId,
    openChatId: family.openChatId,
    branchCount: catalog.branchCount,
    ...(catalog.currentStep ? { currentStep: catalog.currentStep } : {}),
    ...(catalog.latestResult ? { latestResult: catalog.latestResult } : {}),
    unreadResult: catalog.unreadResult,
    attentionKey: catalog.attentionKey,
  }
}

export function listTaskOverviews(completedSince = Date.now()): TaskOverview[] {
  const seen = new Set<string>()
  return listAllChats()
    .filter((chat) => !chat.parent_chat_id)
    .flatMap((chat) => {
      const taskKey = taskKeyForChat(chat.id)
      if (!taskKey || seen.has(taskKey)) return []
      seen.add(taskKey)
      const task = buildTaskOverview(chat.id, completedSince)
      return task ? [task] : []
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function eventProjection(
  chatId: string,
  event: DeliverableChatEvent,
): TaskActivityEvent | undefined {
  if (event.transient === true || event.kind !== 'notification') return undefined
  const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<
    string,
    unknown
  >
  const type = String(event.type ?? '')
  let kind: TaskActivityEvent['kind'] | undefined
  let label = ''
  if (type === 'run.updated') {
    const status = data.status
    if (status === 'running') {
      kind = 'run_started'
      label = '开始运行'
    } else if (status === 'paused') {
      kind = 'paused'
      label = '任务已暂停'
    } else if (status === 'failed') {
      kind = 'failed'
      label = '运行失败'
    } else if (status === 'completed') {
      kind = 'completed'
      label = '运行完成'
    }
  } else if (type === 'turn.started') {
    kind = 'model_started'
    label = 'Agent 正在思考'
  } else if (type === 'sense_started') {
    kind = 'tool_started'
    label = `执行 ${String(data.senseName ?? '工具')}`
  } else if (type === 'accept') {
    kind = 'tool_completed'
    label = `${String(data.senseName ?? '工具')} 已完成`
  } else if (type === 'role_created') {
    kind = 'agent_spawned'
    label = `启动 ${String(data.type ?? '子 Agent')}`
  } else if (type === 'role_reply' || type === 'role_destroyed') {
    kind = 'agent_completed'
    label = `${String(data.type ?? '子 Agent')} 已完成`
  }
  if (!kind) return undefined
  const rootChatId =
    taskKeyForChat(chatId) ??
    (typeof event.rootChatId === 'string' ? event.rootChatId : getRootChatId(chatId))
  const at = Number(data.at ?? data.startedAt ?? data.completedAt ?? data.createdAt) || Date.now()
  return {
    id: `${rootChatId}:${String(event.rootEventSeq ?? event.seq ?? at)}:${kind}`,
    rootChatId,
    chatId,
    kind,
    label,
    at,
  }
}

function sendChange(
  subscriptionId: string,
  subscription: { connectionId: string; completedSince: number; revision: number },
  rootChatId: string,
): void {
  const ws = connectionManager.getWsByConnectionId(subscription.connectionId)
  if (!ws || ws.readyState !== ws.OPEN) {
    subscriptions.delete(subscriptionId)
    return
  }
  subscription.revision += 1
  const task = buildTaskOverview(rootChatId, subscription.completedSince)
  const notification = createNotification('chat.overview.changed', undefined, {
    subscriptionId,
    revision: subscription.revision,
    changes: task ? [{ type: 'upsert', rootChatId, task }] : [{ type: 'remove', rootChatId }],
  })
  ws.send(transport.encode(notification))
}

export function publishOverviewForChat(
  chatId: string,
  activity?: Omit<TaskActivityEvent, 'id' | 'rootChatId' | 'chatId'>,
): void {
  let rootChatId: string
  try {
    rootChatId = taskKeyForChat(chatId) ?? getRootChatId(chatId)
  } catch {
    return
  }
  if (activity) {
    const list = recentEvents.get(rootChatId) ?? []
    list.push({
      ...activity,
      id: `${rootChatId}:${activity.at}:${activity.kind}`,
      rootChatId,
      chatId,
    })
    recentEvents.set(rootChatId, list.slice(-RECENT_EVENT_LIMIT))
  }
  for (const [id, subscription] of subscriptions) sendChange(id, subscription, rootChatId)
}

onPreparedChatEvent((chatId, event) => {
  const projected = eventProjection(chatId, event)
  if (!projected) return
  const list = recentEvents.get(projected.rootChatId) ?? []
  list.push(projected)
  recentEvents.set(projected.rootChatId, list.slice(-RECENT_EVENT_LIMIT))
  for (const [id, subscription] of subscriptions) {
    sendChange(id, subscription, projected.rootChatId)
  }
})

async function handleOpen(
  ctx: HandlerContext,
  data: ChatOverviewOpenRequestData,
): Promise<ChatOverviewOpenResponseData> {
  const subscriptionId = randomUUID()
  const completedSince = data.completedSince ?? Date.now()
  subscriptions.set(subscriptionId, { connectionId: ctx.connectionId, completedSince, revision: 0 })
  return { subscriptionId, revision: 0, tasks: listTaskOverviews(completedSince) }
}

async function handleClose(
  ctx: HandlerContext,
  data: ChatOverviewCloseRequestData,
): Promise<ChatOverviewCloseResponseData> {
  const subscription = subscriptions.get(data.subscriptionId)
  const closed = subscription?.connectionId === ctx.connectionId
  if (closed) subscriptions.delete(data.subscriptionId)
  return { subscriptionId: data.subscriptionId, closed }
}

export function registerChatOverviewHandlers(router: RpcRouter): void {
  if (!resultViewHookRegistered) {
    resultViewHookRegistered = true
    onTaskResultViewChanged((taskKey) => {
      for (const [id, subscription] of subscriptions) sendChange(id, subscription, taskKey)
    })
  }
  router.register(Method.CHAT_OVERVIEW_OPEN, handleOpen)
  router.register(Method.CHAT_OVERVIEW_CLOSE, handleClose)
}

let resultViewHookRegistered = false
