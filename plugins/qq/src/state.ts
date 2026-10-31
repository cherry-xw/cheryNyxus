import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { MessagePartSchema, FileOperationRecordSchema, SourceScopeSchema, SourceRecordRefSchema, SourceSnapshotSchema,
  SourceHandlingSchema, SourceReceiptResultSchema } from '@chery/protocol'
import { parseStored } from './files.js'
import { FailureSchema, EntryFailureSchema } from './failure.js'
import { LearningStateSchema } from './learningState.js'
import {
  QQConfigSchema,
  QQEventSubmitRequestSchema,
  QQNotificationSchema,
  QQDeliveryResultRequestSchema,
} from '../../../packages/protocol/src/qq.js'

// Stored background includes assistant outputs; ingress input remains strict.
export const QQBackgroundSchema = z.object(QQEventSubmitRequestSchema.shape).superRefine((event, ctx) => {
  if (event.senderId !== event.selfId && !QQEventSubmitRequestSchema.safeParse(event).success)
    ctx.addIssue({ code: 'custom', message: 'Invalid background input identity' })
})
export type QQBackground = z.infer<typeof QQBackgroundSchema>

export const QuestionBatchSchema = z.object({
  batchId: z.string(), runId: z.string(),
  items: z.array(z.object({ questionId: z.string(), question: z.string(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })), multiSelect: z.boolean(), eventId: z.string(), answer: z.string().optional(), answerRecord: SourceRecordRefSchema.optional() })),
  replies: z.array(QQEventSubmitRequestSchema), commandId: z.string().optional(),
  status: z.enum(['pending', 'saving', 'saved', 'starting', 'started', 'unknown']),
})
export type QuestionBatch = z.infer<typeof QuestionBatchSchema>
export const JobDataSchema = z.object({
  requestId: z.string(),
  coreRequestId: z.string().optional(),
  coreRunId: z.string().optional(),
  replyActionComplete: z.boolean().optional(),
  videoResendSource: z.string().optional(),
  input: z.object(QQEventSubmitRequestSchema.shape).strict(),
  programSource: z.enum(['reminder', 'app_notification']).optional(),
  target: z.string(),
  conversationKey: z.string(),
  snapshot: z.object({
    revision: z.number().int().nonnegative(),
    config: QQConfigSchema,
    preset: z.string(),
    brain: z.string(),
    senseGroup: z.string(),
    presetId: z.string(),
  }),
  state: z.enum(['queued', 'running', 'sending', 'completed', 'failed', 'paused', 'cancelled']),
  acceptedAt: z.number(),
  startedAt: z.number().optional(),
  queueSequence: z.number().int().nonnegative().safe(),
  lastInputAcceptedAt: z.number().optional(),
  version: z.number().int().positive().default(1),
  sourceScopeId: z.string().optional(),
  sourceRecords: z.array(SourceRecordRefSchema).max(16).optional(),
  sourceSnapshot: SourceSnapshotSchema.optional(),
  sourceMaintenance: z.lazy(() => SourceMaintenanceSchema).optional(),
  executionNotice: z.string().optional(),
  reason: z.string().optional(),
  reply: z.string(),
  inputParts: z.array(MessagePartSchema).optional(),
  mergedInputs: z.array(QQEventSubmitRequestSchema).max(16).optional(),
  outputParts: z.array(MessagePartSchema).optional(),
  outputOperations: z.array(FileOperationRecordSchema).optional(),
  filePreparationPending: z.boolean().optional(),
  decisionRequired: z.boolean().default(false),
  participation: z.enum(['reply', 'wait', 'end']).optional(),
  observe: z.boolean().optional(),
  observationCandidates: z.array(SourceRecordRefSchema).max(1000).optional(),
  anchorRecord: SourceRecordRefSchema.optional(),
  derivedFrom: z.string().optional(),
  contextReads: z.number().int().nonnegative().default(0),
  decisionErrors: z.number().int().nonnegative().optional(),
  background: z.array(QQBackgroundSchema).default([]),
  toolIds: z.array(z.string()),
  douyinUrl: z.string().optional(),
  pendingIcons: z.array(z.string()).default([]),
  progressEmojis: z.record(z.string(), z.string().regex(/^\d+$/)).optional(),
  pendingActivity: z.array(z.string()).default([]),
  activityReplyOffset: z.number().int().nonnegative().default(0),
  sentIcons: z.array(z.string()).default([]),
  waits: z.number().int().nonnegative(),
  nextWaitAt: z.number().optional(),
  outcome: z.string().optional(),
  failureText: z.string().optional(),
  failure: FailureSchema.optional(),
  entryFailure: EntryFailureSchema.optional(),
  questionBatches: z.array(QuestionBatchSchema),
}).strict()
export const JobSchema = JobDataSchema.superRefine((job, ctx) => {
  if (job.programSource) {
    if (job.input.content || job.input.sourceParts.length || job.input.attachments?.length || job.input.parts?.length ||
      job.input.replyToMessageId || job.sourceRecords?.length || job.sourceSnapshot || job.inputParts?.length || job.mergedInputs?.length)
      ctx.addIssue({ code: 'custom', message: 'Program output cannot carry a user input' })
  } else if (!QQEventSubmitRequestSchema.safeParse(job.input).success) {
    ctx.addIssue({ code: 'custom', message: 'Invalid job input' })
  }
})
export type Job = z.infer<typeof JobSchema>
export function currentQuestions(job: Job): QuestionBatch | undefined { return job.questionBatches.at(-1) }
export function nextTargetJob(jobs: Job[], target: string): Job | undefined {
  return jobs.find(job => job.target === target && job.state === 'running') ?? jobs
    .filter(job => job.target === target && job.state === 'queued')
    .sort((a, b) => a.queueSequence - b.queueSequence)[0]
}
export const OutboxSchema = z.object({
  frame: QQNotificationSchema,
  status: z.enum(['pending', 'inflight', 'sent', 'unknown', 'failed']),
  activityReplyThrough: z.number().int().nonnegative().optional(),
  issuedAt: z.number().optional(),
  notBefore: z.number().optional(),
  confirmedAt: z.number().optional(),
  resultHash: z.string().optional(),
  messageIds: z.array(z.string().max(100)).max(1000).optional(),
  result: QQDeliveryResultRequestSchema.optional(),
  sourceScopeId: z.string().optional(),
  sourceRecordedHash: z.string().optional(),
})
export type Outbox = z.infer<typeof OutboxSchema>
export function terminalDelivery(output: Pick<Outbox, 'frame'>): boolean {
  const { type, data } = output.frame
  return (['qq.reply.action', 'qq.reply.file'].includes(type) && data.completeReply === true) ||
    ['qq.request.failed', 'qq.reply.video', 'qq.reply.images'].includes(type) ||
    type === 'qq.reply.part' && data.partIndex === data.totalParts
}
export const SourceMaintenanceSchema = z.object({
  operationId: z.string(), scopeId: z.string(), qqConfigRevision: z.number().int().nonnegative(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  phase: z.enum(['history', 'memory', 'summary', 'commit']),
  startedAt: z.number(), completedAt: z.number().optional(), throughEventId: z.string().optional(),
  lastSummaryAt: z.number().optional(), attempt: z.number().int().nonnegative(), reason: z.string().optional(),
  candidate: z.string().optional(), snapshotId: z.string().optional(), baseSummaryId: z.string().optional(),
  memoryComplete: z.boolean().optional(), memoryInputs: z.array(z.string()).optional(),
  memoryIndex: z.number().int().nonnegative().optional(), memoryBatch: z.unknown().optional(),
  memoryReceipts: z.array(z.object({ operationId: z.string(), fingerprint: z.string() }).strict()).default([]),
  prerequisiteReceipt: z.string().optional(),
  summaryInputs: z.array(z.string()).optional(), summaryResults: z.array(z.string()).optional(),
  summaryLevel: z.number().int().nonnegative().optional(),
  discussionStartedAt: z.number(), discussionClosedAt: z.number(),
}).strict()
export type SourceMaintenance = z.infer<typeof SourceMaintenanceSchema>
export const StateSchema = z
  .object({
    schemaVersion: z.literal(3),
    nextQueueSequence: z.number().int().positive().safe(),
    serviceVersion: z.number().int().nonnegative().safe().default(0),
    contextEpoch: z.string().max(100).default(''),
    imageSources: z.record(z.string(), z.record(z.string(), MessagePartSchema)).default({}),
    jobs: z.array(JobSchema),
    outbox: z.array(OutboxSchema),
    seq: z.record(z.string(), z.number().int().nonnegative()),
    receipts: z.record(z.string(), z.object({ hash: z.string(), accepted: z.boolean() })),
    clearedEvents: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
    toolResults: z.record(z.string(),z.record(z.string(),z.object({status:z.string(),at:z.number(),qqConfigRevision:z.number().int().nonnegative().optional(),configRevision:z.string().optional(),registryVersion:z.number().int().nonnegative().optional()}).strict())).default({}),
    sourceScopes: z.record(z.string(), SourceScopeSchema).default({}),
    sourceReceipts: z.record(z.string(), z.object({
      scopeId: z.string(), receiptId: z.string(), version: z.number().int().positive(), record: SourceRecordRefSchema,
      subject: z.object({ selfId: z.string(), userId: z.string(), conversationType: z.enum(['group', 'private']), groupId: z.string().optional() }),
      handling: SourceHandlingSchema, pendingReceipt: z.boolean(), result: SourceReceiptResultSchema.optional(),
    })).default({}),
    discussions: z.record(z.string(), z.object({ active: z.boolean(), lastActivity: z.number(), startedAt: z.number(),
      closedAt: z.number(), sourceScopeId: z.string(), summaryPending: z.boolean(), summaryRetryAt: z.number(),
       maintenance: SourceMaintenanceSchema.optional() }).strict()).default({}),
    observations: z.record(z.string(), z.object({ checks: z.array(z.number()).max(3600), lastReplyAt: z.number() }).strict()).default({}),
    learning: LearningStateSchema.default(() => LearningStateSchema.parse({})),
    windows: z.record(
      z.string(),
      z.object({ remaining: z.number().int().min(0).max(5), expiresAt: z.number() }),
    ),
    configWrites: z
      .record(z.string(), z.object({ hash: z.string(), response: z.unknown() }))
      .default({}),
    identityBinding: z.object({ selfId: z.string().regex(/^[1-9]\d{0,19}$/), sourceType: z.literal('napcat-action'), verifiedAt: z.number().int().positive(), sourceVersion: z.string().regex(/^[a-z0-9.-]{1,64}$/) }).optional(),
  })
  .strict()
export type State = z.infer<typeof StateSchema>
export function emptyState(): State {
  return {
    schemaVersion: 3,
    nextQueueSequence: 1,
    serviceVersion: 0,
    contextEpoch: '',
    imageSources: {},
    observations: {},
    learning: LearningStateSchema.parse({}),
    jobs: [],
    outbox: [],
    seq: {},
    receipts: {},
    clearedEvents: [],
    toolResults: {},
    sourceScopes: {},
    sourceReceipts: {},
    windows: {},
    discussions: {},
    configWrites: {},
  }
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function targetOf(e: { conversationType: string; targetId: string }): string {
  return e.conversationType === 'group' ? `group:${e.targetId}` : `private:user:${e.targetId}`
}
export function safePath(file: string): void {
  let cursor = path.parse(path.resolve(file)).root
  for (const part of path.resolve(file).slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink rejected')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
}
export function atomicJson(file: string, value: unknown): void {
  safePath(file)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.next`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(value))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temporary, file)
  const directory = fs.openSync(path.dirname(file), 'r')
  try {
    fs.fsyncSync(directory)
  } finally {
    fs.closeSync(directory)
  }
}
export function readState(file: string): State {
  safePath(file)
  const directory=path.dirname(file)
  if(fs.existsSync(directory))for(const name of fs.readdirSync(directory).filter(name=>/^conversation-clean-[a-zA-Z0-9_-]+\.json$/.test(name))){
    const manifest=path.join(directory,name);safePath(manifest)
    const value=JSON.parse(fs.readFileSync(manifest,'utf8'))
    if(!Array.isArray(value.stores)||!Number.isSafeInteger(value.phase)||value.phase!==value.stores.length+2)
      throw new Error('QQ_CONVERSATION_CLEANUP_INCOMPLETE')
  }
  if (!fs.existsSync(file)) return emptyState()
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('Invalid QQ plugin state')
  }
  if (typeof raw === 'object' && raw !== null && (raw as { schemaVersion?: unknown }).schemaVersion === 1)
    throw new Error('Unsupported legacy QQ plugin state (schemaVersion 1); run the one-time source migration before starting')
  if (typeof raw === 'object' && raw !== null && (raw as { schemaVersion?: unknown }).schemaVersion === 2)
    throw new Error('Unsupported QQ question state (schemaVersion 2); run question maintenance before starting')
  try {
    return parseStored(StateSchema, raw, 'state')
  } catch {
    // Corrupt queue state must isolate this plugin rather than drop deliveries.
    throw new Error('Invalid QQ plugin state')
  }
}
