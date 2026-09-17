import { createHash, randomUUID } from 'node:crypto'
import {
  getChat,
  getMessages,
  getRootChatId,
  listChatTrees,
  listRootChatsForPresets,
  type ChatRow,
  type MessageRow,
} from '@/db/chat.js'
import {
  getConversationBranch,
  getConversationBranchByChat,
  getConversationTask,
  listConversationBranches,
  type ConversationBranchRow,
} from '@/db/conversationBranch.js'
import {
  listExecutionNodes,
  listLatestExecutionRuns,
  type ExecutionActiveRunRow,
  type PersistedExecutionNode,
} from '@/db/executionGraph.js'
import { listPendingInteractionsForRoots } from '@/db/interaction.js'
import { getTaskResultView, setTaskResultView } from '@/db/taskResultView.js'
import { getRecentChatEvents } from '@/db/delivery.js'
import { computeCurrentState } from './currentState.js'
import { Method } from '../message/types.js'
import type {
  ChatTaskListRequestData,
  ChatTaskListResponseData,
  ChatTaskResultViewRequestData,
  ChatTaskResultViewResponseData,
  TaskCatalogItem,
  TaskCatalogStatus,
  TaskLatestResult,
  TaskResultStatus,
  TaskSearchMatch,
} from '../message/types.js'
import type { RpcRouter } from '../message/router.js'

const SNAPSHOT_TTL_MS = 30 * 60 * 1000
const resultViewListeners = new Set<(taskKey: string) => void>()
const snapshots = new Map<
  string,
  {
    items: TaskCatalogItem[]
    total: number
    snapshotAt: number
    offset: number
    limit: number
    expiresAt: number
  }
>()

export interface TaskFamily {
  taskKey: string
  taskId?: string
  originalChatId: string
  openChatId: string
  branchRoots: ConversationBranchRow[]
  rows: ChatRow[]
  original: ChatRow
}

interface ProjectedTask {
  item: TaskCatalogItem
  relevance: number
}

function opaqueId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('base64url').slice(0, 24)
}

function visibleContent(message: MessageRow): string {
  return (
    (message.replace_state && message.replace_content
      ? message.replace_content
      : message.content) ?? ''
  )
}

function singleLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, Math.max(1, limit - 1))}…` : normalized
}

function uniqueRows(rows: ChatRow[]): ChatRow[] {
  const byId = new Map<string, ChatRow>()
  for (const row of rows) byId.set(row.id, row)
  return [...byId.values()]
}

export function taskFamilyForChat(chatId: string): TaskFamily | undefined {
  const executionRootId = getRootChatId(chatId)
  const branch = getConversationBranchByChat(executionRootId)
  if (!branch) {
    const original = getChat(executionRootId)
    if (!original || original.lifecycle === 'archived') return undefined
    return {
      taskKey: executionRootId,
      originalChatId: executionRootId,
      openChatId: executionRootId,
      branchRoots: [],
      rows: listChatTrees([executionRootId]),
      original,
    }
  }
  const task = getConversationTask(branch.taskId)
  if (!task) return undefined
  const original = getChat(task.originalChatId)
  if (!original || original.lifecycle === 'archived') return undefined
  const branches = listConversationBranches(task.taskId)
  const active = getConversationBranch(task.activeBranchId)
  const openBranch = active?.kind === 'detail' ? undefined : active
  const fallback = branches.find((candidate) => candidate.kind === 'original')
  const openChatId = openBranch?.chatId ?? fallback?.chatId ?? task.originalChatId
  return {
    taskKey: task.originalChatId,
    taskId: task.taskId,
    originalChatId: task.originalChatId,
    openChatId,
    branchRoots: branches,
    rows: uniqueRows(listChatTrees(branches.map((candidate) => candidate.chatId))),
    original,
  }
}

export function taskKeyForChat(chatId: string): string | undefined {
  try {
    return taskFamilyForChat(chatId)?.taskKey
  } catch {
    return undefined
  }
}

export function onTaskResultViewChanged(listener: (taskKey: string) => void): () => void {
  resultViewListeners.add(listener)
  return () => resultViewListeners.delete(listener)
}

function taskFamiliesForPreset(presetId?: string, preset?: string): TaskFamily[] {
  const roots = listRootChatsForPresets([{ presetId, preset }], { excludeBranches: true })
  const seen = new Set<string>()
  const families: TaskFamily[] = []
  for (const root of roots) {
    const family = taskFamilyForChat(root.id)
    if (!family || seen.has(family.taskKey)) continue
    seen.add(family.taskKey)
    families.push(family)
  }
  return families
}

function latestMainlineRun(family: TaskFamily): ExecutionActiveRunRow | undefined {
  const durable = listLatestExecutionRuns(family.openChatId).find(
    (run) => run.chatId === family.openChatId,
  )
  if (durable) return durable
  const events = getRecentChatEvents(family.openChatId, 10_000)
  let runId: string | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as Record<string, unknown>
    const data = (event.data ?? {}) as Record<string, unknown>
    const candidate =
      typeof data.runId === 'string'
        ? data.runId
        : typeof event.runId === 'string'
          ? event.runId
          : undefined
    if (candidate) {
      runId = candidate
      break
    }
  }
  if (!runId) return undefined
  let status: ExecutionActiveRunRow['status'] = 'waiting'
  let updatedAt = family.original.updated_at
  let legacyError = false
  for (const stored of events) {
    const event = stored as Record<string, unknown>
    const data = (event.data ?? {}) as Record<string, unknown>
    const eventRunId =
      typeof data.runId === 'string'
        ? data.runId
        : typeof event.runId === 'string'
          ? event.runId
          : undefined
    if (eventRunId !== runId) continue
    if (event.type === 'error') legacyError = true
    if (event.type === 'run.outcome') {
      const outcome = data.status
      if (outcome === 'completed' || outcome === 'failed' || outcome === 'paused') status = outcome
    }
    if (event.type === 'run.updated') {
      const next = data.status
      if (
        next === 'running' ||
        next === 'waiting' ||
        next === 'paused' ||
        next === 'completed' ||
        next === 'failed'
      ) {
        status = next
      }
    }
    const at = data.at ?? data.occurredAt ?? data.completedAt ?? data.startedAt
    if (typeof at === 'number') updatedAt = Math.max(updatedAt, at)
  }
  if (status === 'paused' && legacyError) status = 'failed'
  return { rootChatId: family.openChatId, chatId: family.openChatId, runId, status, updatedAt }
}

function terminationForRun(
  rootChatId: string,
  run: ExecutionActiveRunRow,
): PersistedExecutionNode | undefined {
  return listExecutionNodes(rootChatId)
    .filter((node) => (node.runId === run.runId || node.id === run.nodeId) && node.termination)
    .at(-1)
}

function resultStatus(
  run: ExecutionActiveRunRow,
  termination: PersistedExecutionNode | undefined,
): TaskResultStatus | undefined {
  if (run.status === 'completed') return 'completed'
  if (run.status === 'failed') return 'failed'
  if (run.status !== 'paused') return undefined
  const code = (termination?.termination as { code?: unknown } | undefined)?.code
  return code === 'user_abort' ? 'stopped' : 'paused'
}

function latestResult(
  family: TaskFamily,
  run = latestMainlineRun(family),
): TaskLatestResult | undefined {
  if (!run) return undefined
  const nodes = listExecutionNodes(family.openChatId)
  const termination = nodes
    .filter((node) => (node.runId === run.runId || node.id === run.nodeId) && node.termination)
    .at(-1)
  const status = resultStatus(run, termination)
  if (!status) return undefined
  const assistant = nodes
    .filter((node) => {
      const actor = node.actor as { kind?: unknown } | undefined
      return (
        (node.runId === run.runId || node.id === run.nodeId) &&
        node.sourceChatId === family.openChatId &&
        node.kind === 'message' &&
        node.visibility === 'conversation' &&
        actor?.kind === 'agent' &&
        typeof node.content === 'string' &&
        node.content.trim().length > 0
      )
    })
    .at(-1)
  const contentSource = status === 'completed' ? assistant : (termination ?? assistant)
  const content = typeof contentSource?.content === 'string' ? contentSource.content.trim() : ''
  return {
    resultId: opaqueId('task-result', family.taskKey, run.runId, status),
    status,
    completedAt: run.updatedAt ?? contentSource?.updatedAt ?? family.original.updated_at,
    ...(content ? { content: singleLine(content, 400) } : {}),
  }
}

function currentStep(family: TaskFamily): string | undefined {
  const activeTree = listChatTrees([family.openChatId])
  return activeTree
    .flatMap((row) => computeCurrentState(row.id, { executionStepLimit: 20 }).executionSteps ?? [])
    .filter((step) => step.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((step) => (step.kind === 'model' ? '思考中' : step.name || '执行工具'))[0]
}

function taskStatus(
  family: TaskFamily,
  pendingCount: number,
  mainlineRun: ExecutionActiveRunRow | undefined,
): TaskCatalogStatus {
  if (pendingCount > 0) return 'needs_user'
  if (mainlineRun?.status === 'running' || mainlineRun?.status === 'waiting') return 'running'
  const branchRootIds = family.branchRoots.length
    ? family.branchRoots.map((branch) => branch.chatId)
    : [family.originalChatId]
  if (
    branchRootIds.some((rootChatId) =>
      listLatestExecutionRuns(rootChatId).some(
        (run) => run.status === 'running' || run.status === 'waiting',
      ),
    )
  ) {
    return 'running'
  }
  if (!mainlineRun) return 'idle'
  const termination = terminationForRun(family.openChatId, mainlineRun)
  return resultStatus(mainlineRun, termination) ?? 'idle'
}

function matchRanges(text: string, query: string): Array<{ start: number; end: number }> {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(escaped, 'giu')
  const ranges: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(expression)) {
    const start = match.index ?? 0
    ranges.push({ start, end: start + match[0].length })
    if (ranges.length >= 8) break
  }
  return ranges
}

function snippetMatch(
  source: TaskSearchMatch['source'],
  fullText: string,
  query: string,
  chatId?: string,
): TaskSearchMatch | undefined {
  const fullRanges = matchRanges(fullText, query)
  if (fullRanges.length === 0) return undefined
  const first = fullRanges[0]!
  let start = Math.max(0, first.start - 60)
  let end = Math.min(fullText.length, Math.max(first.end + 80, start + 160))
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(fullText[start] ?? '')) start -= 1
  if (end < fullText.length && /[\uDC00-\uDFFF]/u.test(fullText[end] ?? '')) end -= 1
  const text = fullText.slice(start, end)
  return {
    source,
    text,
    highlights: fullRanges
      .filter((range) => range.end > start && range.start < end)
      .map((range) => ({
        start: Math.max(0, range.start - start),
        end: Math.min(end, range.end) - start,
      })),
    ...(chatId ? { branchChatId: chatId } : {}),
  }
}

function searchableMessages(family: TaskFamily): Array<{ row: MessageRow; content: string }> {
  return family.rows.flatMap((chat) =>
    getMessages(chat.id)
      .filter(
        (row) =>
          !row.revoked &&
          (row.role === 'user' || row.role === 'assistant') &&
          visibleContent(row).trim().length > 0,
      )
      .map((row) => ({ row, content: visibleContent(row) })),
  )
}

function projectTask(family: TaskFamily, query?: string): ProjectedTask {
  const messages = searchableMessages(family)
  const userMessages = getMessages(family.openChatId)
    .filter((row) => !row.revoked && row.role === 'user' && visibleContent(row).trim().length > 0)
    .map((row) => ({ row, content: visibleContent(row) }))
  const firstUser = userMessages.reduce<(typeof userMessages)[number] | undefined>(
    (current, entry) =>
      !current || entry.row.created_at < current.row.created_at ? entry : current,
    undefined,
  )
  const lastUser = userMessages.reduce<(typeof userMessages)[number] | undefined>(
    (current, entry) =>
      !current || entry.row.created_at >= current.row.created_at ? entry : current,
    undefined,
  )
  const title = firstUser ? singleLine(firstUser.content, 80) : `任务 ${family.taskKey.slice(0, 8)}`
  const branchRootIds = family.branchRoots.length
    ? family.branchRoots.map((branch) => branch.chatId)
    : [family.originalChatId]
  const taskRunIds = branchRootIds
    .flatMap((rootChatId) => listLatestExecutionRuns(rootChatId).map((run) => run.runId))
    .sort()
  const pending = listPendingInteractionsForRoots(branchRootIds)
  const mainlineRun = latestMainlineRun(family)
  const latest = latestResult(family, mainlineRun)
  const status = taskStatus(family, pending.length, mainlineRun)
  const step = status === 'running' ? currentStep(family) : undefined
  const viewed = getTaskResultView(family.taskKey)
  const updatedAt = Math.max(
    ...family.rows.map((row) => row.updated_at),
    ...pending.map((interaction) => interaction.updatedAt),
    latest?.completedAt ?? 0,
  )
  const normalizedQuery = query?.trim()
  const matches: TaskSearchMatch[] = []
  if (normalizedQuery) {
    const titleMatch = snippetMatch('title', title, normalizedQuery)
    if (titleMatch) matches.push(titleMatch)
    for (const { row, content } of messages) {
      const match = snippetMatch(
        row.role === 'user' ? 'user_prompt' : 'result',
        content,
        normalizedQuery,
        row.chat_id,
      )
      if (match) matches.push(match)
      if (matches.length >= 8) break
    }
  }
  const attentionKey = opaqueId(
    'task-attention',
    family.taskKey,
    taskRunIds.join(','),
    pending
      .map((item) => item.interactionId)
      .sort()
      .join(','),
    latest?.resultId ?? '',
  )
  return {
    relevance: matches.reduce((score, match) => score + (match.source === 'title' ? 4 : 1), 0),
    item: {
      taskKey: family.taskKey,
      ...(family.taskId ? { taskId: family.taskId } : {}),
      originalChatId: family.originalChatId,
      openChatId: family.openChatId,
      title,
      ...(lastUser ? { lastUserPrompt: singleLine(lastUser.content, 160) } : {}),
      status,
      ...(step ? { currentStep: step } : {}),
      ...(latest ? { latestResult: latest } : {}),
      unreadResult: !!latest && viewed?.resultId !== latest.resultId,
      attentionKey,
      createdAt: family.original.created_at,
      updatedAt,
      branchCount: family.branchRoots.length || 1,
      matches,
    },
  }
}

export function projectTaskCatalogItemByChat(chatId: string): TaskCatalogItem | undefined {
  const family = taskFamilyForChat(chatId)
  return family ? projectTask(family).item : undefined
}

function purgeExpiredSnapshots(now: number): void {
  for (const [cursor, snapshot] of snapshots) {
    if (snapshot.expiresAt <= now) snapshots.delete(cursor)
  }
}

function pageFromSnapshot(
  snapshot: Omit<typeof snapshots extends Map<string, infer V> ? V : never, 'expiresAt'>,
): ChatTaskListResponseData {
  const items = snapshot.items.slice(snapshot.offset, snapshot.offset + snapshot.limit)
  const nextOffset = snapshot.offset + items.length
  let nextCursor: string | undefined
  if (nextOffset < snapshot.total) {
    nextCursor = randomUUID()
    snapshots.set(nextCursor, {
      ...snapshot,
      offset: nextOffset,
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    })
  }
  return {
    items,
    total: snapshot.total,
    snapshotAt: snapshot.snapshotAt,
    ...(nextCursor ? { nextCursor } : {}),
  }
}

export async function handleChatTaskList(
  _ctx: unknown,
  data: ChatTaskListRequestData,
): Promise<ChatTaskListResponseData> {
  const now = Date.now()
  purgeExpiredSnapshots(now)
  if (data.cursor) {
    const snapshot = snapshots.get(data.cursor)
    if (!snapshot) throw new Error('任务列表快照已失效，请刷新后重试')
    snapshot.expiresAt = now + SNAPSHOT_TTL_MS
    return pageFromSnapshot({ ...snapshot, limit: data.limit ?? snapshot.limit })
  }
  const query = data.query?.trim()
  let projected = taskFamiliesForPreset(data.presetId, data.preset).map((family) =>
    projectTask(family, query),
  )
  if (query) projected = projected.filter((entry) => entry.item.matches.length > 0)
  if (data.statuses?.length) {
    const statuses = new Set(data.statuses)
    projected = projected.filter((entry) => statuses.has(entry.item.status))
  }
  if (data.updatedFrom !== undefined) {
    projected = projected.filter((entry) => entry.item.updatedAt >= data.updatedFrom!)
  }
  if (data.updatedTo !== undefined) {
    projected = projected.filter((entry) => entry.item.updatedAt <= data.updatedTo!)
  }
  const sort = data.sort ?? (query ? 'relevance' : 'updated_desc')
  projected.sort((a, b) => {
    if (sort === 'relevance' && b.relevance !== a.relevance) return b.relevance - a.relevance
    if (sort === 'created_desc')
      return b.item.createdAt - a.item.createdAt || b.item.taskKey.localeCompare(a.item.taskKey)
    return (
      b.item.updatedAt - a.item.updatedAt ||
      b.item.createdAt - a.item.createdAt ||
      b.item.taskKey.localeCompare(a.item.taskKey)
    )
  })
  const items = projected.map((entry) => entry.item)
  return pageFromSnapshot({
    items,
    total: items.length,
    snapshotAt: now,
    offset: 0,
    limit: data.limit ?? 24,
  })
}

export async function handleChatTaskResultView(
  _ctx: unknown,
  data: ChatTaskResultViewRequestData,
): Promise<ChatTaskResultViewResponseData> {
  const family = taskFamilyForChat(data.taskKey)
  const current = family ? latestResult(family) : undefined
  if (!family || !current || current.resultId !== data.resultId) {
    return {
      taskKey: data.taskKey,
      resultId: data.resultId,
      viewed: false,
      ...(current ? { latestResultId: current.resultId } : {}),
    }
  }
  const viewedAt = Date.now()
  setTaskResultView(family.taskKey, current.resultId, viewedAt)
  for (const listener of resultViewListeners) listener(family.taskKey)
  return { taskKey: family.taskKey, resultId: current.resultId, viewed: true, viewedAt }
}

export function registerTaskCatalogHandlers(router: RpcRouter): void {
  router.register(Method.CHAT_TASK_LIST, handleChatTaskList)
  router.register(Method.CHAT_TASK_RESULT_VIEW, handleChatTaskResultView)
}
