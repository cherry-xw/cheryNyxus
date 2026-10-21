import { z } from 'zod'

const id = z.string().min(1).max(256)
const count = z.number().int().nonnegative().safe()

export const AgentCommandStatusSchema = z.enum([
  'running', 'background', 'cancel_requested', 'exited', 'killed', 'timed_out', 'result_unknown',
])
export type AgentCommandStatus = z.infer<typeof AgentCommandStatusSchema>
export const ACTIVE_COMMAND_STATUSES: readonly AgentCommandStatus[] = ['running', 'background', 'cancel_requested']

export const CommandDrainSummarySchema = z.object({
  status: z.enum(['active', 'complete', 'partial', 'failed']),
  lineCount: count,
  skippedLineCount: count,
  truncatedLineCount: count,
  retiredLineCount: count,
  templates: z.array(z.object({
    id: count,
    stream: z.enum(['stdout', 'stderr']),
    template: z.string(),
    count,
    samples: z.array(z.string()).max(3),
  }).strict()).max(200),
}).strict()
export type CommandDrainSummary = z.infer<typeof CommandDrainSummarySchema>

export const CommandLogIssueSchema = z.enum(['command_quota', 'global_quota', 'buffer_limit', 'write_error', 'restart', 'transport'])
export type CommandLogIssue = z.infer<typeof CommandLogIssueSchema>

export const AgentCommandRecordSchema = z.object({
  commandId: id,
  backendInstanceId: id,
  chatId: id,
  rootChatId: id,
  runId: id.nullable(),
  toolCallId: id.nullable(),
  sourceKind: z.enum(['host_bash', 'managed_exec', 'managed_publish']),
  command: z.string(),
  description: z.string(),
  workdir: z.string().nullable(),
  executionId: id.nullable(),
  status: AgentCommandStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: count,
  endedAt: count.nullable(),
  version: count,
  logStatus: z.enum(['active', 'complete', 'partial_truncated', 'expired', 'evicted_by_quota', 'write_error']),
  logIssues: z.array(CommandLogIssueSchema),
  logSequence: count,
  totalRawBytes: count,
  totalNewlines: count,
  storedCompressedBytes: count,
  /** Recovery or transport loss cannot establish how much output never reached this writer. */
  logTailUnconfirmed: z.boolean(),
  drainSummary: CommandDrainSummarySchema.nullable(),
}).strict()
export type AgentCommandRecord = z.infer<typeof AgentCommandRecordSchema>

/** Byte offsets refer to sanitized output. Base64 preserves chunk boundaries within UTF-8 sequences. */
export const CommandLogChunkSchema = z.object({
  commandId: id,
  sequence: count,
  stream: z.enum(['stdout', 'stderr']),
  receivedAt: count,
  byteStart: count,
  byteEnd: count,
  lineStart: count,
  lineEnd: count,
  dataBase64: z.string(),
}).strict()
export type CommandLogChunk = z.infer<typeof CommandLogChunkSchema>

export const CommandLogGapSchema = z.object({
  sequenceStart: count,
  sequenceEnd: count,
  byteStart: count,
  byteEnd: count,
  lineStart: count,
  lineEnd: count,
}).strict()
export type CommandLogGap = z.infer<typeof CommandLogGapSchema>

export const CommandLogPageSchema = z.object({
  chunks: z.array(CommandLogChunkSchema),
  gaps: z.array(CommandLogGapSchema),
  nextCursor: count,
  hasMore: z.boolean(),
  command: AgentCommandRecordSchema,
}).strict()
export type CommandLogPage = z.infer<typeof CommandLogPageSchema>

export const AgentCommandCursorSchema = z.object({ startedAt: count, commandId: id }).strict()
export const AgentCommandListRequestSchema = z.object({
  chatId: id.optional(),
  includeChildren: z.boolean().optional(),
  scope: z.enum(['active', 'history', 'all']).optional(),
  before: AgentCommandCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
export const AgentCommandListResponseSchema = z.object({
  commands: z.array(AgentCommandRecordSchema),
  nextCursor: AgentCommandCursorSchema.nullable(),
}).strict()
export const AgentCommandGetRequestSchema = z.object({ commandId: id }).strict()
export const AgentCommandGetResponseSchema = z.object({ command: AgentCommandRecordSchema }).strict()
export const AgentCommandLogsReadRequestSchema = z.object({
  commandId: id, cursor: count.optional(), direction: z.enum(['forward', 'backward']).optional(),
  limit: z.number().int().min(1).max(16).optional(),
}).strict()
export const AgentCommandStopResponseSchema = z.object({
  accepted: z.boolean(), command: AgentCommandRecordSchema,
}).strict()
export const AgentCommandSubscribeRequestSchema = z.object({
  chatId: id.optional(), includeChildren: z.boolean().optional(), commandId: id.optional(),
}).strict().refine((input) => !input.commandId || !input.chatId, '请选择会话或单条命令订阅')
export const AgentCommandSubscribeResponseSchema = z.object({ subscriptionId: id }).strict()
export const AgentCommandUnsubscribeRequestSchema = z.object({ subscriptionId: id }).strict()
export const AgentCommandUnsubscribeResponseSchema = z.object({ removed: z.boolean() }).strict()
export const AgentCommandUpdatedSchema = z.object({ subscriptionId: id, command: AgentCommandRecordSchema }).strict()
export const AgentCommandLogEventSchema = z.object({ subscriptionId: id, chunk: CommandLogChunkSchema }).strict()

export type AgentCommandMethodMap = {
  'agent.command.list': { params: z.infer<typeof AgentCommandListRequestSchema>; result: z.infer<typeof AgentCommandListResponseSchema> }
  'agent.command.get': { params: z.infer<typeof AgentCommandGetRequestSchema>; result: z.infer<typeof AgentCommandGetResponseSchema> }
  'agent.command.logs.read': { params: z.infer<typeof AgentCommandLogsReadRequestSchema>; result: CommandLogPage }
  'agent.command.stop': { params: z.infer<typeof AgentCommandGetRequestSchema>; result: z.infer<typeof AgentCommandStopResponseSchema> }
  'agent.command.subscribe': { params: z.infer<typeof AgentCommandSubscribeRequestSchema>; result: z.infer<typeof AgentCommandSubscribeResponseSchema> }
  'agent.command.unsubscribe': { params: z.infer<typeof AgentCommandUnsubscribeRequestSchema>; result: z.infer<typeof AgentCommandUnsubscribeResponseSchema> }
}
