import { z } from 'zod'

export const SourceIdSchema = z.string().min(1).max(256)
export const SourceTimeSchema = z.number().int().nonnegative().safe()
export const SourceRevisionSchema = z.number().int().min(1).safe()
const ordinal = z.number().int().nonnegative().safe()
const nativeId = z.string().regex(/^-?\d{1,100}$/)
const qqId = z.string().regex(/^[1-9]\d{0,19}$/)
const partId = z.string().regex(/^p\d+(?:\.\d+)?$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)

export const SourceConversationKeySchema = z.object({
  ownerId: SourceIdSchema, channel: SourceIdSchema, selfId: qqId,
  conversationType: z.enum(['group', 'private']), targetId: qqId,
}).strict()
export const SourceRecordRefSchema = z.object({ recordId: SourceIdSchema, revision: SourceRevisionSchema }).strict()
export const SourcePartRefSchema = SourceRecordRefSchema.extend({ partId }).strict()
export const SourcePartSchema = z.discriminatedUnion('type', [
  z.object({ partId, type: z.literal('text'), text: z.string().max(100000) }).strict(),
  z.object({ partId, type: z.literal('mention'), target: z.union([qqId, z.literal('all')]) }).strict(),
  z.object({ partId, type: z.literal('reply'), platformMessageId: nativeId }).strict(),
  z.object({ partId, type: z.literal('attachment'), attachmentId: SourceIdSchema }).strict(),
  z.object({ partId, type: z.literal('unsupported'), sourceType: z.string().min(1).max(100), description: z.string().max(1000).optional() }).strict(),
])
export const SourcePartsSchema = z.array(SourcePartSchema).max(200).superRefine((parts, ctx) => {
  if (new Set(parts.map(p => p.partId)).size !== parts.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate source part' })
  if (parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0) > 100000)
    ctx.addIssue({ code: 'custom', message: 'Source text exceeds limit' })
  if (parts.filter(p => p.type === 'attachment').length > 30)
    ctx.addIssue({ code: 'custom', message: 'Too many source attachments' })
})
export const SourceOrderSchema = z.object({
  kind: z.enum(['napcat_message_seq', 'napcat_real_seq']), value: z.string().regex(/^\d{1,100}$/), domain: SourceIdSchema,
}).strict()
export const SourceRecordSchema = z.object({
  recordId: SourceIdSchema, conversationId: SourceIdSchema, revision: SourceRevisionSchema,
  ingestOrdinal: SourceRevisionSchema, sourceKey: SourceIdSchema, origin: z.enum(['member', 'bot_delivery']),
  sender: z.object({ id: qqId, name: z.string().max(100) }).strict(),
  platformMessageIds: z.array(nativeId).max(1000), receivedAt: SourceTimeSchema,
  platformSentAt: SourceTimeSchema.optional(), deliveryConfirmedAt: SourceTimeSchema.optional(),
  sourceOrder: SourceOrderSchema.optional(), parts: SourcePartsSchema, deliveryId: SourceIdSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if (record.origin === 'bot_delivery' ? !record.deliveryId : !record.platformMessageIds.length)
    ctx.addIssue({ code: 'custom', message: 'Missing source identity' })
  if (new Set(record.platformMessageIds).size !== record.platformMessageIds.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate platform alias' })
})
export const SourceScopeSchema = z.object({
  scopeId: SourceIdSchema, conversationId: SourceIdSchema, presetId: SourceIdSchema,
  qqContextEpoch: z.string().max(256), generation: SourceRevisionSchema,
  state: z.enum(['active', 'retired', 'deleting', 'deleted']), createdAt: SourceTimeSchema,
  coreBinding: z.object({ chatId: SourceIdSchema, epochId: SourceIdSchema }).strict().optional(),
  permissionRevision: SourceRevisionSchema, selectionRevision: ordinal,
}).strict()
export const SourceHandlingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('background') }).strict(),
  z.object({ kind: z.enum(['queued', 'merged']), requestId: SourceIdSchema }).strict(),
  z.object({ kind: z.literal('question_answer'), requestId: SourceIdSchema, runId: SourceIdSchema, batchId: SourceIdSchema, questionId: SourceIdSchema }).strict(),
  z.object({ kind: z.literal('rejected'), reasonCode: SourceIdSchema }).strict(),
])
export const SourceReceiptResultSchema = z.object({
  receiptId: SourceIdSchema, version: SourceRevisionSchema, eventId: SourceIdSchema,
  record: SourceRecordRefSchema, storage: z.literal('stored'), handling: SourceHandlingSchema,
}).strict()
export const SourceReceiptStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_found') }).strict(),
  z.object({ state: z.literal('pending'), receiptId: SourceIdSchema, record: SourceRecordRefSchema, reasonCode: SourceIdSchema.optional() }).strict(),
  z.object({ state: z.literal('completed'), result: SourceReceiptResultSchema, currentSourceState: z.enum(['retained', 'deleted']) }).strict(),
])
export const SourceReceiptSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), receiptId: SourceIdSchema, version: SourceRevisionSchema, record: SourceRecordRefSchema }).strict(),
  z.object({ state: z.literal('completed'), receiptId: SourceIdSchema, version: SourceRevisionSchema, record: SourceRecordRefSchema, result: SourceReceiptResultSchema }).strict(),
])
export const SourceAttachmentStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['pending', 'acquiring']) }).strict(),
  z.object({ kind: z.literal('stored'), assetId: SourceIdSchema, assetVersionId: SourceIdSchema }).strict(),
  z.object({ kind: z.literal('unavailable'), reasonCode: SourceIdSchema }).strict(),
])
export const SourceAttachmentVersionSchema = z.object({
  attachmentId: SourceIdSchema, version: SourceRevisionSchema, source: SourcePartRefSchema,
  sourceId: SourceIdSchema, originalName: z.string().max(200).optional(), declaredMimeType: z.string().max(200).optional(),
  mediaKind: z.enum(['image', 'audio', 'video', 'document', 'file']), state: SourceAttachmentStateSchema,
}).strict()
export const SourceWorkspaceMountSchema = z.object({
  slotKey: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/), scope: z.literal('source'), scopeId: SourceIdSchema,
  containerPath: z.string().max(512), cwd: z.string().max(240), extractedDir: z.string().max(512),
  entryFile: z.literal('archive.zip'), sizeBytes: ordinal.positive().max(104857600), sha256: hash,
}).strict().superRefine((value, ctx) => {
  const root = `/workspace/files/incoming-zips/${value.slotKey}`
  if (value.containerPath !== `${root}/archive.zip` || value.extractedDir !== `${root}/extracted` || value.cwd !== `incoming-zips/${value.slotKey}`)
    ctx.addIssue({ code: 'custom', message: 'Invalid source mount' })
})
export const SourceQuoteSchema = z.object({
  source: SourcePartRefSchema, platformMessageId: nativeId,
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('resolved'), target: SourceRecordRefSchema }).strict(),
    z.object({ kind: z.enum(['not_retained', 'out_of_scope', 'ambiguous', 'unsupported']) }).strict(),
  ]),
}).strict()
export const SourcePartSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ partId, mode: z.literal('expand') }).strict(),
  z.object({ partId, mode: z.literal('summary_reference'), summaryId: SourceIdSchema }).strict(),
  z.object({ partId, mode: z.literal('tool_result_reference'), toolMessageId: SourceIdSchema }).strict(),
])
export const SourceSelectionReasonsSchema = z.array(z.enum(['current', 'recent', 'explicit_quote'])).min(1).max(3)
  .refine(v => new Set(v).size === v.length, 'Duplicate selection reason')
export const SourceSnapshotItemSchema = z.union([
  z.object({ type: z.literal('message'), recordId: SourceIdSchema, revision: SourceRevisionSchema,
    selectionReasons: SourceSelectionReasonsSchema, parts: z.array(SourcePartSelectionSchema).max(200) }).strict(),
  z.object({ type: z.literal('summary'), summaryId: SourceIdSchema, revision: SourceRevisionSchema }).strict(),
  z.object({ type: z.literal('gap'), reason: z.literal('omitted_from_context'), omittedSetId: SourceIdSchema,
    knownMessageCount: SourceRevisionSchema, firstRecord: SourceRecordRefSchema, lastRecord: SourceRecordRefSchema,
    partiallySummarizedCount: ordinal }).strict()
    .refine(v => v.partiallySummarizedCount <= v.knownMessageCount, 'Invalid summarized count'),
  z.object({ type: z.literal('gap'), reason: z.enum(['reception_unconfirmed', 'history_start', 'source_deleted']), completenessRecordId: SourceIdSchema }).strict(),
])
export const SourceInputSchema = z.object({
  kind: z.literal('source_snapshot'), requestId: SourceIdSchema, scopeId: SourceIdSchema,
  snapshotId: SourceIdSchema, actorRecord: SourceRecordRefSchema,
  inputRecords: z.array(SourceRecordRefSchema).min(1).max(16), turnId: SourceIdSchema,
}).strict().superRefine((v, ctx) => {
  if (!v.inputRecords.some(r => r.recordId === v.actorRecord.recordId && r.revision === v.actorRecord.revision))
    ctx.addIssue({ code: 'custom', message: 'Actor is not an input record' })
  if (new Set(v.inputRecords.map(r => r.recordId)).size !== v.inputRecords.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate input record' })
})
export const SourceSnapshotSchema = z.object({
  snapshotId: SourceIdSchema, requestId: SourceIdSchema, scopeId: SourceIdSchema, snapshotVersion: z.literal(1),
  turnId: SourceIdSchema.optional(),
  selectionRevision: ordinal, throughIngestOrdinal: ordinal, selectedAt: SourceTimeSchema,
  qqConfigRevision: ordinal, ordering: z.enum(['time_approximate', 'verified_sequence']),
  selectionStats: z.object({ recentRecordCount: ordinal, recentTextCodePoints: ordinal }).strict(),
  actorRecord: SourceRecordRefSchema.optional(), inputRecords: z.array(SourceRecordRefSchema).max(16),
  maintenancePurpose: z.enum(['capacity', 'discussion', 'learning']).optional(),
  orderedItems: z.array(SourceSnapshotItemSchema), quoteRelations: z.array(SourceQuoteSchema), parentSnapshotId: SourceIdSchema.optional(),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.maintenancePurpose ? snapshot.actorRecord !== undefined || snapshot.inputRecords.length > 0
    : !snapshot.actorRecord || !snapshot.inputRecords.some(ref => ref.recordId === snapshot.actorRecord!.recordId && ref.revision === snapshot.actorRecord!.revision))
    ctx.addIssue({ code: 'custom', message: 'Invalid snapshot actor' })
})
const textRange = z.object({ unit: z.literal('utf16'), start: ordinal, end: ordinal }).strict().refine(v => v.end >= v.start)
export const SourceDataRefSchema = z.discriminatedUnion('kind', [
  z.object({ dataId: SourceIdSchema, revision: SourceRevisionSchema, kind: z.literal('memory'),
    provenance: z.object({ kind: z.literal('memory'), entryId: SourceIdSchema, entryRevision: SourceRevisionSchema }).strict() }).strict(),
  z.object({ dataId: SourceIdSchema, revision: SourceRevisionSchema, kind: z.literal('description'),
    provenance: z.object({ kind: z.literal('description'), descriptionId: SourceIdSchema, version: SourceRevisionSchema, source: SourcePartRefSchema }).strict() }).strict(),
  z.object({ dataId: SourceIdSchema, revision: SourceRevisionSchema, kind: z.literal('execution_notice'),
    provenance: z.object({ kind: z.literal('execution_notice'), factId: SourceIdSchema, revision: SourceRevisionSchema }).strict() }).strict(),
])
export const SourceFactRefSchema = z.object({ factId: SourceIdSchema, revision: SourceRevisionSchema,
  kind: z.enum(['execution', 'delivery', 'action', 'receipt']) }).strict()
export const SourceToolMessageRefSchema = z.object({ runId: SourceIdSchema, messageId: SourceIdSchema, sequence: ordinal,
  kind: z.enum(['assistant_call', 'tool_result', 'role_return']), bodyHash: hash }).strict()
export const SourceManifestItemSchema = z.object({
  itemId: SourceIdSchema,
  sourceRef: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('record'), record: SourceRecordRefSchema, partId: partId.optional() }).strict(),
    z.object({ kind: z.literal('summary'), summaryId: SourceIdSchema, revision: SourceRevisionSchema }).strict(),
    z.object({ kind: z.literal('data'), data: SourceDataRefSchema }).strict(),
    z.object({ kind: z.literal('tool'), message: SourceToolMessageRefSchema }).strict(),
    z.object({ kind: z.literal('fact'), fact: SourceFactRefSchema }).strict(),
    z.object({ kind: z.literal('gap'), snapshotItemId: SourceIdSchema }).strict(),
  ]),
  position: z.object({ messageIndex: ordinal, blockIndex: ordinal }).strict(), representation: z.enum(['text', 'native', 'reference']),
  renderedTextRef: SourceIdSchema.optional(), provisionId: SourceIdSchema.optional(), range: textRange.optional(),
}).strict().superRefine((v, ctx) => {
  if (v.representation === 'text' && !v.renderedTextRef || v.representation === 'native' && !v.provisionId || v.range && v.representation !== 'text')
    ctx.addIssue({ code: 'custom', message: 'Invalid rendered source mapping' })
})
const provisionBase = {
  provisionId: SourceIdSchema, source: SourcePartRefSchema, attachmentVersion: SourceRevisionSchema,
  acquisitionState: z.enum(['pending', 'acquiring', 'stored', 'unavailable']), inputOrigin: z.enum(['current', 'history', 'quote']),
  modelStepId: SourceIdSchema, assetId: SourceIdSchema.optional(), assetVersionId: SourceIdSchema.optional(),
}
export const SourceFileProvisionSchema = z.discriminatedUnion('representation', [
  z.object({ ...provisionBase, representation: z.literal('native'), actualMimeType: z.string().min(1).max(200),
    transportRef: SourceIdSchema, binaryBytes: ordinal, inputBlockPosition: z.object({ messageIndex: ordinal, blockIndex: ordinal }).strict(), transformRef: SourceIdSchema.optional() }).strict(),
  z.object({ ...provisionBase, representation: z.literal('extracted_text'), extractionId: SourceIdSchema, textRef: SourceIdSchema,
    range: z.object({ unit: z.enum(['page', 'utf16']), start: ordinal, end: ordinal }).strict().refine(v => v.end >= v.start), truncated: z.boolean() }).strict(),
  z.object({ ...provisionBase, representation: z.literal('description'), descriptionId: SourceIdSchema, version: SourceRevisionSchema,
    sourceType: z.enum(['user', 'model', 'service']), observationRef: SourceIdSchema, userDescriptionOnly: z.boolean() }).strict(),
  z.object({ ...provisionBase, representation: z.literal('tool_reference'), reader: z.object({
    kind: z.enum(['tool', 'role']), id: SourceIdSchema, operation: SourceIdSchema, capabilityRevision: ordinal,
  }).strict(), availability: z.enum(['available', 'requires_approval', 'requires_selection']),
    workspaceMount: z.object({ scope: z.literal('source'), scopeId: SourceIdSchema, containerPath: z.string().max(512),
      cwd: z.string().max(240), extractedDir: z.string().max(512), entryFile: z.literal('archive.zip'), sizeBytes: ordinal, sha256: hash }).strict().optional(),
  }).strict(),
  z.object({ ...provisionBase, representation: z.literal('metadata_only'), reasonCode: z.enum([
     'not_acquired', 'missing', 'permission_denied', 'expired_from_context', 'unsupported', 'no_reader', 'budget_excluded', 'shared_representation',
   ]), sharedProvisionId: SourceIdSchema.optional() }).strict(),
]).superRefine((v, ctx) => {
  if (!!v.assetId !== !!v.assetVersionId || v.acquisitionState === 'stored' && !v.assetId)
    ctx.addIssue({ code: 'custom', message: 'Invalid fixed asset identity' })
   if (v.representation === 'native' && v.acquisitionState !== 'stored')
     ctx.addIssue({ code: 'custom', message: 'Native input requires stored bytes' })
   if (v.representation === 'metadata_only' && (v.reasonCode === 'shared_representation') !== !!v.sharedProvisionId)
     ctx.addIssue({ code: 'custom', message: 'Shared representation requires a provision reference' })
})
export const SourceModelProjectionSchema = z.object({
  projectionId: SourceIdSchema, modelStepId: SourceIdSchema, snapshotId: SourceIdSchema,
  runtimeConfigRevision: SourceIdSchema, registryVersion: ordinal, model: SourceIdSchema, protocol: SourceIdSchema,
  toolNames: z.array(SourceIdSchema), fileInputs: z.array(SourceFileProvisionSchema), dataContextRefs: z.array(SourceDataRefSchema),
  executionFactRefs: z.array(SourceFactRefSchema), toolHistoryRefs: z.array(SourceToolMessageRefSchema),
  orderedInputManifest: z.array(SourceManifestItemSchema), budgetSnapshotId: SourceIdSchema.optional(), contentFingerprint: hash,
}).strict()
export const SourceAttemptSchema = z.object({
  attemptId: SourceIdSchema, projectionId: SourceIdSchema, attemptSequence: SourceRevisionSchema,
  state: z.enum(['prepared', 'invoking', 'responded', 'failed', 'unknown', 'cancelled']), version: SourceRevisionSchema,
  startedAt: SourceTimeSchema.optional(), finishedAt: SourceTimeSchema.optional(), outcomeKnown: z.boolean(),
  reasonCode: SourceIdSchema.optional(), responseRef: SourceIdSchema.optional(),
  usage: z.object({ inputTokens: ordinal.optional(), outputTokens: ordinal.optional(), totalTokens: ordinal.optional() }).strict().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.state === 'prepared' && v.startedAt !== undefined || v.state === 'invoking' && v.startedAt === undefined ||
      ['responded', 'unknown'].includes(v.state) && v.startedAt === undefined ||
      ['unknown', 'invoking'].includes(v.state) && v.outcomeKnown || v.state === 'cancelled' && v.startedAt !== undefined && v.outcomeKnown)
    ctx.addIssue({ code: 'custom', message: 'Invalid call outcome' })
})
export const SourceSummaryEvidenceSchema = z.object({
  record: SourceRecordRefSchema, textPartIds: z.array(partId), attachments: z.array(z.object({
    partId, attachmentVersion: SourceRevisionSchema, representation: z.enum(['metadata_only', 'description', 'extracted_text', 'native']),
    evidenceRef: SourceIdSchema.optional(), range: z.object({ unit: z.enum(['page', 'utf16']), start: ordinal, end: ordinal }).strict().refine(v => v.end >= v.start).optional(),
  }).strict()),
}).strict()
export const SourceSummarySchema = z.object({
  summaryId: SourceIdSchema, scopeId: SourceIdSchema, revision: SourceRevisionSchema, operationId: SourceIdSchema,
  purpose: z.enum(['capacity', 'discussion']), text: z.string().min(1).max(12000), committedAt: SourceTimeSchema,
  evidence: z.array(SourceSummaryEvidenceSchema), replacement: z.array(z.object({ record: SourceRecordRefSchema, partIds: z.array(partId) }).strict()),
}).strict()
export const SourceTextRefSchema = z.object({
  textRefId: SourceIdSchema, revision: SourceRevisionSchema, totalCodePoints: ordinal,
  preview: z.string(), previewCodePoints: ordinal, complete: z.boolean(), nextCursor: z.string().min(1).max(4096).nullable(),
}).strict().superRefine((v, ctx) => {
  if (Array.from(v.preview).length !== v.previewCodePoints || v.previewCodePoints > v.totalCodePoints ||
      v.complete !== (v.previewCodePoints === v.totalCodePoints) || v.complete !== (v.nextCursor === null))
    ctx.addIssue({ code: 'custom', message: 'Invalid text continuation' })
})
export const SourceTextPageSchema = z.object({
  requestId: SourceIdSchema, textRefId: SourceIdSchema, revision: SourceRevisionSchema,
  startCodePoint: ordinal, endCodePoint: ordinal, text: z.string(), totalCodePoints: ordinal,
  nextCursor: SourceIdSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.endCodePoint < v.startCodePoint || v.endCodePoint > v.totalCodePoints ||
    Array.from(v.text).length !== v.endCodePoint - v.startCodePoint ||
    (v.nextCursor === null) !== (v.endCodePoint === v.totalCodePoints))
    ctx.addIssue({ code: 'custom', message: 'Invalid source text page' })
})
export const SourceHistoryRecordSchema = z.object({
  source: SourceRecordRefSchema, origin: SourceRecordSchema.shape.origin, sender: SourceRecordSchema.shape.sender,
  platformMessageIds: SourceRecordSchema.shape.platformMessageIds,
  time: z.object({ at: SourceTimeSchema, basis: z.enum(['platform_sent', 'delivery_confirmed', 'received']) }).strict(),
  parts: z.array(z.discriminatedUnion('type', [
    z.object({ partId, type: z.literal('text'), body: SourceTextRefSchema }).strict(),
    z.object({ partId, type: z.literal('mention'), target: z.union([qqId, z.literal('all')]) }).strict(),
    z.object({ partId, type: z.literal('reply'), platformMessageId: nativeId }).strict(),
    z.object({ partId, type: z.literal('attachment'), attachmentId: SourceIdSchema, version: SourceRevisionSchema,
      originalName: z.string().max(200).optional(), mediaKind: SourceAttachmentVersionSchema.shape.mediaKind,
      acquisitionState: z.enum(['pending', 'acquiring', 'stored', 'unavailable']), contentRead: z.literal(false) }).strict(),
    z.object({ partId, type: z.literal('unsupported'), sourceType: z.string().max(100), description: z.string().max(1000).optional() }).strict(),
  ])),
}).strict()
export const SourceHistoryResultSchema = z.object({
  historySource: z.literal('retained'), scopeId: SourceIdSchema, throughIngestOrdinal: ordinal,
  ordering: z.literal('time_approximate'), records: z.array(SourceHistoryRecordSchema).max(100),
  completeness: z.array(z.object({ kind: z.enum(['history_start', 'reception_unconfirmed', 'source_deleted']),
    observedAt: SourceTimeSchema }).strict()), nextCursor: SourceIdSchema.nullable(),
}).strict()
export const SourceReadSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('records'), refs: z.array(SourceRecordRefSchema).max(1000) }).strict(),
  z.object({ kind: z.literal('snapshot'), snapshotId: SourceIdSchema, cursor: SourceIdSchema.optional(),
    limit: z.number().int().min(1).max(100).optional() }).strict(),
])
export const SourceReadResultSchema = z.object({
  scopeId: SourceIdSchema, observedAt: SourceTimeSchema,
  items: z.array(z.discriminatedUnion('state', [
    z.object({ ref: SourceRecordRefSchema, state: z.literal('available'), record: SourceRecordSchema }).strict(),
    z.object({ ref: SourceRecordRefSchema, state: z.literal('unavailable'),
      reasonCode: z.enum(['not_retained', 'permission_denied', 'source_deleted']) }).strict(),
  ])), nextCursor: SourceIdSchema.nullable(),
}).strict()

export type SourceConversationKey = z.infer<typeof SourceConversationKeySchema>
export type SourceRecordRef = z.infer<typeof SourceRecordRefSchema>
export type SourcePartRef = z.infer<typeof SourcePartRefSchema>
export type SourcePart = z.infer<typeof SourcePartSchema>
export type SourceRecord = z.infer<typeof SourceRecordSchema>
export type SourceScope = z.infer<typeof SourceScopeSchema>
export type SourceHandling = z.infer<typeof SourceHandlingSchema>
export type SourceReceipt = z.infer<typeof SourceReceiptSchema>
export type SourceReceiptResult = z.infer<typeof SourceReceiptResultSchema>
export type SourceReceiptStatus = z.infer<typeof SourceReceiptStatusSchema>
export type SourceAttachmentVersion = z.infer<typeof SourceAttachmentVersionSchema>
export type SourceWorkspaceMount = z.infer<typeof SourceWorkspaceMountSchema>
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>
export type SourceSnapshotItem = z.infer<typeof SourceSnapshotItemSchema>
export type SourceInput = z.infer<typeof SourceInputSchema>
export type SourceFileProvision = z.infer<typeof SourceFileProvisionSchema>
export type SourceModelProjection = z.infer<typeof SourceModelProjectionSchema>
export type SourceDataRef = z.infer<typeof SourceDataRefSchema>
export type SourceToolMessageRef = z.infer<typeof SourceToolMessageRefSchema>
export type SourceManifestItem = z.infer<typeof SourceManifestItemSchema>
export type SourceAttempt = z.infer<typeof SourceAttemptSchema>
export type SourceSummary = z.infer<typeof SourceSummarySchema>
export type SourceSummaryEvidence = z.infer<typeof SourceSummaryEvidenceSchema>
export type SourceTextRef = z.infer<typeof SourceTextRefSchema>
export type SourceTextPage = z.infer<typeof SourceTextPageSchema>
export type SourceHistoryRecord = z.infer<typeof SourceHistoryRecordSchema>
export type SourceHistoryResult = z.infer<typeof SourceHistoryResultSchema>
export type SourceReadSelection = z.infer<typeof SourceReadSelectionSchema>
export type SourceReadResult = z.infer<typeof SourceReadResultSchema>
