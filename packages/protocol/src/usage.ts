import { z } from 'zod'

const count = z.number().int().nonnegative()
export const UsageMetricSchema = z.object({
  value: z.number().nonnegative().nullable(),
  source: z.enum(['provider', 'estimate', 'derived', 'mixed', 'unknown']),
  coverage: z.enum(['complete', 'partial', 'none']),
  knownCount: count,
  totalCount: count,
})
export type UsageMetric = z.infer<typeof UsageMetricSchema>
export const RequestUsageSchema = z.object({
  attemptId: z.string(),
  taskKey: z.string(),
  chatId: z.string(),
  runId: z.string().optional(),
  branchId: z.string().optional(),
  inputMessageId: z.string().optional(),
  model: z.string(),
  provider: z.string(),
  protocol: z.string(),
  startedAt: count,
  endedAt: count.optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  usage: z.object({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    totalTokens: count.optional(),
    cacheReadTokens: count.optional(),
    cacheWriteTokens: count.optional(),
    reasoningTokens: count.optional(),
  }),
  context: z.object({ system: count, tools: count, conversation: count, limit: count.nullable() }),
})
export type RequestUsage = z.infer<typeof RequestUsageSchema>
export const UsageOperationSchema = z.object({
  id: z.string(),
  taskKey: z.string(),
  chatId: z.string(),
  attemptId: z.string().optional(),
  toolName: z.string(),
  startedAt: count,
  endedAt: count.optional(),
  status: z.enum(['running', 'completed', 'rejected', 'interrupted']),
})
export type UsageOperation = z.infer<typeof UsageOperationSchema>

export const TaskUsageSummarySchema = z.object({
  taskKey: z.string(),
  inputTokens: UsageMetricSchema,
  outputTokens: UsageMetricSchema,
  totalTokens: UsageMetricSchema,
  requests: UsageMetricSchema,
  rounds: UsageMetricSchema,
  retryCount: UsageMetricSchema,
  agentCount: count,
  capturedSince: count.nullable(),
  currentRequest: RequestUsageSchema.nullable(),
  latestRequest: RequestUsageSchema.nullable().optional(),
})
export type TaskUsageSummary = z.infer<typeof TaskUsageSummarySchema>
export const TaskUsageDetailSchema = z.object({
  asOf: count,
  revision: z.string(),
  summary: TaskUsageSummarySchema,
  agents: z.array(
    z.object({
      chatId: z.string(),
      name: z.string(),
      isMain: z.boolean(),
      lifecycle: z.string(),
      totalTokens: UsageMetricSchema,
      requests: UsageMetricSchema,
      rounds: UsageMetricSchema,
      currentRequest: RequestUsageSchema.nullable(),
    }),
  ),
  cache: z.object({
    readTokens: UsageMetricSchema,
    writeTokens: UsageMetricSchema,
    reportedRequests: count,
    hitRequests: count,
    totalRequests: count,
  }),
  elapsedMs: UsageMetricSchema,
  activeMs: UsageMetricSchema,
  tools: z.array(
    z.object({
      name: z.string(),
      calls: count,
      rejected: count,
      interrupted: count,
      durationMs: count,
    }),
  ),
  /** 请求与工具明细供统计概览构造趋势和当前上下文快照；旧服务端可不返回。 */
  requests: z.array(RequestUsageSchema).optional(),
  operations: z.array(UsageOperationSchema).optional(),
})
export type TaskUsageDetail = z.infer<typeof TaskUsageDetailSchema>
export const UsageTaskRequestSchema = z.object({ taskKey: z.string().min(1) })
export const UsageBatchRequestSchema = z.object({ taskKeys: z.array(z.string().min(1)).max(100) })
export const UsagePageRequestSchema = UsageTaskRequestSchema.extend({
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
export type UsagePageRequest = z.infer<typeof UsagePageRequestSchema>
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00Z`)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  }, '无效日期')
const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, '无效时区')
export const UsageDailyRequestSchema = z
  .object({ from: date, to: date, timezone, presetId: z.string().optional() })
  .refine((value) => {
    const days = (Date.parse(value.to) - Date.parse(value.from)) / 86400000
    return days >= 0 && days < 366
  }, '日期范围须为 1 至 366 天')
export type UsageDailyRequest = z.infer<typeof UsageDailyRequestSchema>
export const UsageDayTasksRequestSchema = z.object({
  date,
  timezone,
  presetId: z.string().optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
export const UsageDailyPointSchema = z.object({
  date,
  tokens: UsageMetricSchema,
  taskKeys: z.array(z.string()),
  state: z.enum(['complete', 'partial', 'unknown', 'future']),
})
export const UsageDailyResponseSchema = z.object({
  asOf: count,
  from: date,
  to: date,
  timezone,
  capturedSince: count.nullable(),
  points: z.array(UsageDailyPointSchema),
})
export type UsageDailyResponse = z.infer<typeof UsageDailyResponseSchema>
export const UsageRequestsResponseSchema = z.object({
  asOf: count,
  items: z.array(RequestUsageSchema),
  nextCursor: z.string().optional(),
})
export const UsageOperationsResponseSchema = z.object({
  asOf: count,
  items: z.array(UsageOperationSchema),
  nextCursor: z.string().optional(),
})
export const UsageBatchResponseSchema = z.object({
  asOf: count,
  items: z.array(TaskUsageSummarySchema),
})
export const UsageDayTasksResponseSchema = z.object({
  asOf: count,
  items: z.array(z.object({ taskKey: z.string(), tokens: UsageMetricSchema })),
  nextCursor: z.string().optional(),
})

export const ContextContentRequestSchema = z.object({
  chatId: z.string().min(1),
  epochId: z.string().min(1).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
export const ContextContentResponseSchema = z.object({
  chatId: z.string(),
  epochId: z.string().optional(),
  snapshotId: z.string(),
  origin: z.enum(['frozen', 'reconstructed', 'missing']),
  contentState: z.enum(['available', 'partial', 'missing']),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['system', 'tool']),
      name: z.string(),
      content: z.string(),
    }),
  ),
  nextCursor: z.string().optional(),
})
export type ContextContentResponse = z.infer<typeof ContextContentResponseSchema>
