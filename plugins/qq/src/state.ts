import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { MessagePartSchema, FileOperationRecordSchema } from '@chery/protocol'
import { parseStored } from './files.js'
import {
  QQConfigSchema,
  QQEventSubmitRequestSchema,
  QQNotificationSchema,
} from '../../../packages/protocol/src/qq.js'

// Stored background includes assistant outputs; ingress input remains strict.
export const QQBackgroundSchema = z.object(QQEventSubmitRequestSchema.shape).superRefine((event, ctx) => {
  if (event.senderId !== event.selfId && !QQEventSubmitRequestSchema.safeParse(event).success)
    ctx.addIssue({ code: 'custom', message: 'Invalid background input identity' })
})
export type QQBackground = z.infer<typeof QQBackgroundSchema>

export const JobSchema = z.object({
  requestId: z.string(),
  coreRequestId: z.string().optional(),
  coreRunId: z.string().optional(),
  replyActionComplete: z.boolean().optional(),
  videoResendSource: z.string().optional(),
  input: QQEventSubmitRequestSchema,
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
  state: z.enum(['queued', 'running', 'sending', 'completed', 'failed', 'paused']),
  acceptedAt: z.number(),
  reason: z.string().optional(),
  reply: z.string(),
  inputParts: z.array(MessagePartSchema).optional(),
  mergedInputs: z.array(QQEventSubmitRequestSchema).max(16).optional(),
  outputParts: z.array(MessagePartSchema).optional(),
  outputOperations: z.array(FileOperationRecordSchema).optional(),
  filePreparationPending: z.boolean().optional(),
  decisionRequired: z.boolean().default(false),
  participation: z.enum(['reply', 'wait', 'end']).optional(),
  background: z.array(QQBackgroundSchema).default([]),
  toolIds: z.array(z.string()),
  douyinUrl: z.string().optional(),
  pendingIcons: z.array(z.string()).default([]),
  pendingActivity: z.array(z.string()).default([]),
  activityReplyOffset: z.number().int().nonnegative().default(0),
  sentIcons: z.array(z.string()).default([]),
  waits: z.number().int().nonnegative(),
  nextWaitAt: z.number().optional(),
  outcome: z.string().optional(),
})
export type Job = z.infer<typeof JobSchema>
export const OutboxSchema = z.object({
  frame: QQNotificationSchema,
  status: z.enum(['pending', 'inflight', 'sent', 'unknown', 'failed']),
  activityReplyThrough: z.number().int().nonnegative().optional(),
  issuedAt: z.number().optional(),
  notBefore: z.number().optional(),
  confirmedAt: z.number().optional(),
  resultHash: z.string().optional(),
  messageIds: z.array(z.string().max(100)).max(100).optional(),
})
export type Outbox = z.infer<typeof OutboxSchema>
export const StateSchema = z
  .object({
    schemaVersion: z.literal(1),
    contextEpoch: z.string().max(100).default(''),
    jobs: z.array(JobSchema),
    outbox: z.array(OutboxSchema),
    seq: z.record(z.string(), z.number().int().nonnegative()),
    receipts: z.record(z.string(), z.object({ hash: z.string(), accepted: z.boolean() })),
    discussions: z.record(z.string(), z.object({ active: z.boolean(), lastActivity: z.number(), startedAt: z.number().default(0), closedAt: z.number().default(0), summary: z.string().default(''), summaryPending: z.boolean().default(false), summaryRetryAt: z.number().default(0), messages: z.array(QQBackgroundSchema) })).default({}),
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
    schemaVersion: 1,
    contextEpoch: '',
    jobs: [],
    outbox: [],
    seq: {},
    receipts: {},
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
  if (!fs.existsSync(file)) return emptyState()
  try {
    return parseStored(StateSchema, JSON.parse(fs.readFileSync(file, 'utf8')), 'state')
  } catch {
    // Corrupt queue state must isolate this plugin rather than drop deliveries.
    throw new Error('Invalid QQ plugin state')
  }
}
