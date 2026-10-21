import { z } from 'zod'

export const BACKEND_FORCE_GRACE_MS = 10_000

const id = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative().safe()

export const BackendStopBlockerSchema = z.object({
  id,
  kind: z.enum(['agent', 'question', 'approval', 'command', 'external', 'config', 'cleanup']),
  description: z.string().max(1000),
  chatId: id.optional(),
  commandId: id.optional(),
}).strict()

export const BackendStopSnapshotSchema = z.object({
  backendInstanceId: id,
  operationId: id.nullable(),
  version: timestamp,
  phase: z.enum(['running', 'requesting', 'draining', 'closing', 'force_stopping', 'stopped']),
  desiredState: z.enum(['running', 'stopped']),
  canCancel: z.boolean(),
  connection: z.enum(['connected', 'lost']),
  requestedAt: timestamp.nullable(),
  forceDeadlineAt: timestamp.nullable(),
  blockers: z.array(BackendStopBlockerSchema),
  parkedInputCount: timestamp,
  unknownExternalOperations: z.array(z.object({ id, description: z.string().max(1000) }).strict()),
  error: z.string().max(2000).nullable(),
}).strict()

export type BackendStopSnapshot = z.infer<typeof BackendStopSnapshotSchema>
export type BackendStopBlocker = z.infer<typeof BackendStopBlockerSchema>

/** Operation identity is a fence, not authorization. Only controlled local IPC may carry these. */
const operation = { backendInstanceId: id, operationId: id }
export const BackendLifecycleRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stop-drain'), ...operation }).strict(),
  z.object({ type: z.literal('stop-cancel'), ...operation }).strict(),
  z.object({ type: z.literal('stop-force'), ...operation, deadlineAt: timestamp }).strict(),
  z.object({ type: z.literal('stop-query'), backendInstanceId: id }).strict(),
])
export type BackendLifecycleRequest = z.infer<typeof BackendLifecycleRequestSchema>

export const BackendLifecycleEventSchema = z.object({
  type: z.literal('stop-state'),
  state: BackendStopSnapshotSchema,
}).strict()

/** Local IPC only. Registration is retained by each parent until the process group is gone. */
export const BackendProcessEventSchema = z.object({
  type: z.literal('backend-process'),
  backendInstanceId: id,
  action: z.enum(['register', 'release']),
  kind: z.enum(['worker', 'command']),
  pid: z.number().int().min(1).max(2_147_483_647),
  commandId: id.optional(),
}).strict()
export type BackendProcessEvent = z.infer<typeof BackendProcessEventSchema>

export const BackendManagedTaskEventSchema = z.object({
  type: z.literal('backend-managed-task'), backendInstanceId: id, action: z.enum(['register', 'release']),
  commandId: id, userId: z.string().regex(/^[1-9][0-9]{4,19}$/),
  appId: z.string().min(3).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  taskId: z.string().regex(/^task_[a-f0-9]{16}$/),
}).strict()
export type BackendManagedTaskEvent = z.infer<typeof BackendManagedTaskEventSchema>
