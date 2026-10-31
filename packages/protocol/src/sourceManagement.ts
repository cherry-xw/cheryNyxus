import { z } from 'zod'
import { SourceIdSchema as id, SourceRecordRefSchema, SourceHistoryRecordSchema, SourceTextRefSchema,
  SourceTextPageSchema, SourceAttemptSchema, SourceFileProvisionSchema, SourceSnapshotSchema, SourceDataRefSchema,
  SourceSummaryEvidenceSchema } from './sourceContext.js'

const number = z.number().int().nonnegative().safe()
const page = { cursor: id.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }
const request = { requestId: id }
const selected = { ...request, snapshotId: id, modelStepId: id.optional(), projectionId: id.optional(), attemptId: id.optional() }
export const QQSourceRequestSchemas = {
  'qq.context.index': z.object({ ...request, ...page }).strict(),
  'qq.context.get': z.object({ ...selected, ...page }).strict(),
  'qq.context.text': z.object({ ...request, textRefId: id, cursor: id.optional() }).strict(),
  'qq.context.sources': z.object({ ...request, snapshotId: id, relationId: id, ...page }).strict(),
  'qq.context.locate': z.object({ ...request, snapshotId: id, projectionId: id.optional(), itemId: id }).strict(),
  'qq.entry.items': z.object({ ...request, kind: z.enum(['messages', 'deliveries', 'summaries']), ...page }).strict(),
} as const
export const SourceVisibleBodySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), text: SourceTextRefSchema }).strict(),
  z.object({ state: z.literal('unavailable'), reason: z.enum(['permission_denied', 'source_deleted', 'legacy_partial', 'not_recorded']) }).strict(),
])
const parts = SourceHistoryRecordSchema.shape.parts.element
export const SourceVisiblePartSchema = z.union([
  z.object({ partId: z.string(), type: z.literal('text'), body: SourceVisibleBodySchema }).strict(),
  z.object({ partId: z.string(), type: z.literal('reply'), relationId: id,
    result: z.enum(['selected', 'source_only', 'not_retained', 'source_deleted', 'permission_denied', 'outside_scope']) }).strict(),
  parts.options[1], parts.options[3], parts.options[4],
])
const visibleSource = {
  source: SourceRecordRefSchema, origin: SourceHistoryRecordSchema.shape.origin, sender: SourceHistoryRecordSchema.shape.sender,
  platformMessageIds: SourceHistoryRecordSchema.shape.platformMessageIds, time: SourceHistoryRecordSchema.shape.time,
  parts: z.array(SourceVisiblePartSchema),
}
const position = { itemId: id, position: number }
export const SourceContextItemSchema = z.discriminatedUnion('type', [
  z.object({ ...position, type: z.literal('message'), ...visibleSource,
    selectionReasons: z.array(z.enum(['current', 'recent', 'explicit_quote'])),
    partSelection: SourceSnapshotSchema.shape.orderedItems.element.options[0].shape.parts }).strict(),
  z.object({ ...position, type: z.literal('summary'), summaryId: id, revision: number,
    purpose: z.enum(['capacity', 'discussion']), body: SourceVisibleBodySchema, relationId: id, coveredRecordCount: number, committedAt: number }).strict(),
  z.object({ ...position, type: z.literal('gap'), reason: z.enum(['omitted_from_context', 'history_start', 'reception_unconfirmed', 'source_deleted']),
    relationId: id, knownMessageCount: number.optional(), firstRecord: SourceRecordRefSchema.optional(), lastRecord: SourceRecordRefSchema.optional(),
    partiallySummarizedCount: number.optional(), observedStartAt: number.optional(), observedEndAt: number.optional() }).strict(),
  z.object({ ...position, type: z.literal('data'), source: SourceDataRefSchema, body: SourceVisibleBodySchema }).strict(),
  z.object({ ...position, type: z.literal('tool_result'), runId: id, messageId: id, callId: id, toolName: z.string(),
    status: z.enum(['completed', 'failed', 'unknown', 'cancelled']), publicResult: SourceVisibleBodySchema }).strict(),
  z.object({ ...position, type: z.literal('restricted'), reason: z.literal('permission_denied') }).strict(),
])
export const SourceDirectoryEntrySchema = z.object({ modelStepId: id, stepSequence: number, reason: z.enum(['initial', 'tool_continue', 'question_resume', 'approval_resume']),
  projectionId: id, projectionSequence: number, snapshotId: id, preparedAt: number,
  attempt: z.object({attemptId:id,attemptSequence:number,state:SourceAttemptSchema.shape.state,
    startedAt:number.optional(),finishedAt:number.optional(),outcomeKnown:z.boolean(),reasonCode:id.optional(),usage:SourceAttemptSchema.shape.usage}).strict().optional() }).strict()
const selection = z.object({ snapshotId: id, modelStepId: id, projectionId: id, attemptId: id.optional() }).strict()
const common = { requestId: id, observedAt: number, nextCursor: id.nullable() }
export const SourceContextIndexSchema = z.object({ ...common,
  generatedReply: SourceVisibleBodySchema.optional(),
  availability: z.enum(['not_prepared', 'snapshot_only', 'available', 'not_applicable', 'legacy_unrecorded', 'preparation_failed']),
  snapshotId: id.optional(), defaultSelection: selection.optional(), selectedEntry: SourceDirectoryEntrySchema.optional(),
  associatedSummaryIds: z.array(id), items: z.array(SourceDirectoryEntrySchema), reasonCode: id.optional() }).strict()
export const SourceContextBudgetSchema = z.object({ contextLimit: number.optional(), outputReserve: number.optional(), safetyMargin: number.optional(),
  effectiveCeiling: number.optional(), tokenSource: z.enum(['official-preflight', 'conservative-local-estimate']),
  officialPreflight: z.enum(['succeeded', 'unavailable', 'unsupported']), inputTokens: number.optional(), estimatedTextTokens: number, mediaTokens: z.null() }).strict()
export const SourceContextViewSchema = z.object({ ...common, state: z.enum(['snapshot_only', 'available']), snapshotId: id,
  ordering: z.literal('time_approximate'), items: z.array(SourceContextItemSchema), modelStepId: id.optional(), projectionId: id.optional(),
  attemptId: id.optional(), attemptState: SourceAttemptSchema.shape.state.optional(), usage: SourceAttemptSchema.shape.usage,
  model: z.string().optional(), protocol: z.string().optional(), runtimeConfigRevision: id.optional(),
  fileInputs: z.array(SourceFileProvisionSchema).optional(), budget: SourceContextBudgetSchema.optional(), total: number }).strict()
export const SourceContextSourcesSchema = z.object({ ...common, snapshotId: id, relationId: id,
  items: z.array(z.object({ source: SourceRecordRefSchema, includedInSelectedInput: z.boolean(), selectionReasons: z.array(z.enum(['current', 'recent', 'explicit_quote'])),
    itemId: id.optional(),
    evidence: SourceSummaryEvidenceSchema.optional(), record: z.object(visibleSource).strict().optional(),
    unavailableReason: z.enum(['permission_denied', 'source_deleted', 'not_retained']).optional() }).strict()) }).strict()
export const SourceEntryItemsSchema = z.object({ ...common, kind: z.enum(['messages', 'deliveries', 'summaries']), total: number,
  items: z.array(z.discriminatedUnion('type', [
    z.object({ itemId: id, type: z.literal('message'), ...visibleSource }).strict(),
    z.object({ itemId: id, type: z.literal('delivery'), purpose: z.string(), sequence: number, status: z.enum(['pending', 'inflight', 'sent', 'unknown', 'failed']),
      body: SourceVisibleBodySchema, messageIds: z.array(z.string()), fileIds: z.array(z.string()), fileUploaded: z.boolean().optional(),
      confirmedAt: number.optional(), partIndex: number.optional(), totalParts: number.optional() }).strict(),
    z.object({ itemId: id, type: z.literal('summary'), operationId: id, purpose: z.enum(['capacity', 'discussion']), status: z.string(), phase: z.string(),
      body: SourceVisibleBodySchema, summaryId: id.optional(), reasonCode: id.optional() }).strict(),
  ])) }).strict()
export const QQSourceResponseSchemas = {
  'qq.context.index': SourceContextIndexSchema, 'qq.context.get': SourceContextViewSchema,
  'qq.context.text': SourceTextPageSchema, 'qq.context.sources': SourceContextSourcesSchema,
  'qq.context.locate': z.object({ requestId: id, snapshotId: id, projectionId: id.optional(), itemId: id, cursor: id }).strict(),
  'qq.entry.items': SourceEntryItemsSchema,
} as const
export type SourceManagementMethod = keyof typeof QQSourceRequestSchemas
export type SourceManagementQuery = { [K in SourceManagementMethod]: { method: K; params: z.infer<(typeof QQSourceRequestSchemas)[K]> } }[SourceManagementMethod]
export type SourceManagementResult = z.infer<(typeof QQSourceResponseSchemas)[SourceManagementMethod]>
export type SourceContextIndex = z.infer<typeof SourceContextIndexSchema>
export type SourceContextView = z.infer<typeof SourceContextViewSchema>
export type SourceContextItem = z.infer<typeof SourceContextItemSchema>
export type SourceVisibleBody = z.infer<typeof SourceVisibleBodySchema>
export type SourceVisiblePart = z.infer<typeof SourceVisiblePartSchema>
export type SourceDirectoryEntry = z.infer<typeof SourceDirectoryEntrySchema>
