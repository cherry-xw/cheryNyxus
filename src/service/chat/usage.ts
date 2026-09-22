import type { HandlerContext } from '../message/router.js'
import { Method, type ParamsOf, type ResultOf } from '../message/types.js'
import { getChat } from '@/db/chat.js'
import { getChatFamily, listChatFamilies } from '@/db/chatFamily.js'
import {
  readRequestUsage,
  readRequestUsagePage,
  readUsageOperations,
  readUsageOperationsPage,
} from '@/db/usage.js'
import { handleChatPromptSnapshot } from './promptSnapshot.js'
import type { UsageMetric } from '@chery/protocol'

const metric = (value: number | null, known = value !== null): UsageMetric => ({
  value,
  source: known ? ('provider' as const) : ('unknown' as const),
  coverage: known ? ('complete' as const) : ('none' as const),
  knownCount: known ? 1 : 0,
  totalCount: 1,
})
function taskChats(taskKey: string) {
  const family = getChatFamily(taskKey)
  return family?.chats ?? (getChat(taskKey) ? [getChat(taskKey)!] : [])
}
function usageTimestamp(row: ReturnType<typeof readRequestUsage>[number]): number | undefined {
  return row.endedAt ?? (row.status === 'running' ? row.startedAt : undefined)
}
function sum(
  records: ReturnType<typeof readRequestUsage>,
  key: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens' | 'cacheWriteTokens',
) {
  const known = records.filter((r) => r.usage[key] !== undefined)
  return known.length
    ? {
        ...metric(known.reduce((n, r) => n + (r.usage[key] ?? 0), 0)),
        coverage: known.length === records.length ? ('complete' as const) : ('partial' as const),
        knownCount: known.length,
        totalCount: records.length,
      }
    : metric(null, false)
}
function summary(taskKey: string) {
  const records = readRequestUsage(taskKey)
  const rounds = new Set(records.map((r) => r.inputMessageId).filter(Boolean))
  return {
    taskKey,
    inputTokens: sum(records, 'inputTokens'),
    outputTokens: sum(records, 'outputTokens'),
    totalTokens: sum(records, 'totalTokens'),
    requests: metric(records.length),
    rounds: metric(rounds.size),
    retryCount: metric(Math.max(0, records.length - rounds.size)),
    agentCount: new Set(records.map((r) => r.chatId)).size,
    capturedSince: records[0]?.startedAt ?? null,
    currentRequest: records.findLast((r) => r.status === 'running') ?? null,
    latestRequest: records.at(-1) ?? null,
  }
}
export async function handleUsageSummaries(
  _ctx: HandlerContext,
  data: ParamsOf<typeof Method.CHAT_USAGE_SUMMARIES>,
): Promise<ResultOf<typeof Method.CHAT_USAGE_SUMMARIES>> {
  return { asOf: Date.now(), items: data.taskKeys.map(summary) }
}
export async function handleUsageDetail(
  _ctx: HandlerContext,
  data: ParamsOf<typeof Method.CHAT_USAGE_DETAIL>,
): Promise<ResultOf<typeof Method.CHAT_USAGE_DETAIL>> {
  const chats = taskChats(data.taskKey)
  const records = readRequestUsage(data.taskKey)
  const ops = readUsageOperations(data.taskKey)
  const agents = chats.map((chat) => {
    const own = records.filter((r) => r.chatId === chat.id)
    return {
      chatId: chat.id,
      name: chat.id,
      isMain: chat.id === data.taskKey,
      lifecycle: chat.lifecycle ?? 'unknown',
      totalTokens: sum(own, 'totalTokens'),
      requests: metric(own.length),
      rounds: metric(new Set(own.map((r) => r.inputMessageId).filter(Boolean)).size),
      currentRequest: own.findLast((r) => r.status === 'running') ?? null,
    }
  })
  return {
    asOf: Date.now(),
    revision: String(records.at(-1)?.endedAt ?? records.at(-1)?.startedAt ?? 0),
    summary: summary(data.taskKey),
    agents,
    cache: {
      readTokens: sum(records, 'cacheReadTokens'),
      writeTokens: sum(records, 'cacheWriteTokens'),
      reportedRequests: records.filter((r) => r.usage.inputTokens !== undefined).length,
      hitRequests: records.filter((r) => (r.usage.cacheReadTokens ?? 0) > 0).length,
      totalRequests: records.length,
    },
    elapsedMs: metric(
      records.length ? (records.at(-1)!.endedAt ?? Date.now()) - records[0]!.startedAt : 0,
    ),
    activeMs: metric(records.reduce((n, r) => n + ((r.endedAt ?? Date.now()) - r.startedAt), 0)),
    tools: [...new Set(ops.map((o) => o.toolName))].map((name) => {
      const own = ops.filter((o) => o.toolName === name)
      return {
        name,
        calls: own.length,
        rejected: own.filter((o) => o.status === 'rejected').length,
        interrupted: own.filter((o) => o.status === 'interrupted').length,
        durationMs: own.reduce((n, o) => n + ((o.endedAt ?? Date.now()) - o.startedAt), 0),
      }
    }),
    requests: records,
    operations: ops,
  }
}
export async function handleUsageRounds(
  _ctx: HandlerContext,
  data: ParamsOf<typeof Method.CHAT_USAGE_ROUNDS>,
): Promise<ResultOf<typeof Method.CHAT_USAGE_ROUNDS>> {
  const page = readRequestUsagePage(data.taskKey, data.cursor, data.limit)
  return {
    asOf: Date.now(),
    items: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}
export async function handleUsageOperations(
  _ctx: HandlerContext,
  data: ParamsOf<typeof Method.CHAT_USAGE_OPERATIONS>,
): Promise<ResultOf<typeof Method.CHAT_USAGE_OPERATIONS>> {
  const page = readUsageOperationsPage(data.taskKey, data.cursor, data.limit)
  return {
    asOf: Date.now(),
    items: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}
export async function handleUsageDaily(
  _ctx: HandlerContext,
  data: ParamsOf<typeof Method.CHAT_USAGE_DAILY>,
): Promise<ResultOf<typeof Method.CHAT_USAGE_DAILY>> {
  const all = listChatFamilies().flatMap((family) => readRequestUsage(family.rootChatId))
  const points: Array<{
    date: string
    tokens: ReturnType<typeof metric>
    taskKeys: string[]
    state: 'complete' | 'partial' | 'unknown' | 'future'
  }> = []
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone }).format(new Date())
  const start = Date.parse(`${data.from}T12:00:00Z`),
    end = Date.parse(`${data.to}T12:00:00Z`)
  for (let time = start; time <= end; time += 86400000) {
    // Iterate calendar labels in the requested range; format request timestamps in the IANA zone below.
    const date = new Date(time).toISOString().slice(0, 10)
    const rows = all.filter(
      (row) =>
        usageTimestamp(row) &&
        new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone }).format(
          new Date(usageTimestamp(row)!),
        ) === date,
    )
    const tokens = rows.length ? sum(rows, 'totalTokens') : metric(null, false)
    points.push({
      date,
      tokens,
      taskKeys: [...new Set(rows.map((row) => row.taskKey))],
      state:
        date > today
          ? 'future'
          : tokens.value === null
            ? 'unknown'
            : tokens.coverage === 'partial'
              ? 'partial'
              : 'complete',
    })
  }
  return {
    asOf: Date.now(),
    from: data.from,
    to: data.to,
    timezone: data.timezone,
    capturedSince: all[0]?.startedAt ?? null,
    points,
  }
}
export async function handleUsageDayTasks(
  _ctx: HandlerContext,
  data: ParamsOf<typeof Method.CHAT_USAGE_DAY_TASKS>,
): Promise<ResultOf<typeof Method.CHAT_USAGE_DAY_TASKS>> {
  const all = listChatFamilies().flatMap((family) => readRequestUsage(family.rootChatId))
  const rows = all.filter(
    (row) =>
      usageTimestamp(row) &&
      new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone }).format(
        new Date(usageTimestamp(row)!),
      ) === data.date,
  )
  const grouped = new Map<string, typeof rows>()
  for (const row of rows) grouped.set(row.taskKey, [...(grouped.get(row.taskKey) ?? []), row])
  const items = [...grouped].map(([taskKey, rows]) => ({
    taskKey,
    tokens: sum(rows, 'totalTokens'),
  }))
  const offset = data.cursor ? Math.max(0, Number.parseInt(data.cursor, 10) + 1) : 0
  const limit = Math.min(100, Math.max(1, data.limit ?? 30))
  return {
    asOf: Date.now(),
    items: items.slice(offset, offset + limit),
    ...(offset + limit < items.length ? { nextCursor: String(offset + limit - 1) } : {}),
  }
}
export async function handleContextContent(
  ctx: HandlerContext,
  data: ParamsOf<typeof Method.CHAT_CONTEXT_CONTENT>,
): Promise<ResultOf<typeof Method.CHAT_CONTEXT_CONTENT>> {
  const snapshot = await handleChatPromptSnapshot(ctx, data)
  const all = [
    {
      id: `${snapshot.chatId}:system`,
      kind: 'system' as const,
      name: '系统提示词',
      content: snapshot.systemPrompt,
    },
    ...snapshot.tools.map((tool) => ({
      id: `${snapshot.chatId}:tool:${tool.name}`,
      kind: 'tool' as const,
      name: tool.name,
      content: JSON.stringify(tool),
    })),
  ]
  const offset = data.cursor ? Math.max(0, Number.parseInt(data.cursor, 10) + 1) : 0
  const limit = Math.min(100, Math.max(1, data.limit ?? 30))
  const items = all.slice(offset, offset + limit)
  return {
    chatId: snapshot.chatId,
    epochId: snapshot.epochId,
    snapshotId: `${snapshot.chatId}:${snapshot.epochId ?? 'current'}`,
    origin: snapshot.origin ?? 'reconstructed',
    contentState: snapshot.contentState ?? 'available',
    items,
    ...(offset + limit < all.length ? { nextCursor: String(offset + limit - 1) } : {}),
  }
}
export function registerUsageHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.CHAT_USAGE_SUMMARIES, handleUsageSummaries)
  router.register(Method.CHAT_USAGE_DETAIL, handleUsageDetail)
  router.register(Method.CHAT_USAGE_ROUNDS, handleUsageRounds)
  router.register(Method.CHAT_USAGE_OPERATIONS, handleUsageOperations)
  router.register(Method.CHAT_CONTEXT_CONTENT, handleContextContent)
  router.register(Method.CHAT_USAGE_DAILY, handleUsageDaily)
  router.register(Method.CHAT_USAGE_DAY_TASKS, handleUsageDayTasks)
}
