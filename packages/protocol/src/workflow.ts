import { z } from 'zod'

const id = z.string().min(1).max(256)
const count = z.number().int().nonnegative()
export const WorkflowNodeIdSchema = z.enum([
  'context',
  'command',
  'input',
  'model',
  'retry',
  'tools',
  'checkpoint',
  'decision',
  'compact',
  'result',
])
export type WorkflowNodeId = z.infer<typeof WorkflowNodeIdSchema>
export const WorkflowStatusSchema = z.enum([
  'idle',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'unknown',
])
export const WorkflowResourcesSchema = z.object({
  memoryCount: count.optional(),
  skillCount: count.optional(),
  loadedSkillCount: count.optional(),
  loadedSkillsComplete: z.boolean(),
})
export const WorkflowCallSchema = z.object({
  id,
  name: id,
  status: z.enum([
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'rejected',
    'cancelled',
    'unknown',
  ]),
  summary: z.string().max(200).optional(),
  beforeHook: z.boolean().optional(),
  afterHook: z.boolean().optional(),
  resources: WorkflowResourcesSchema.optional(),
})
export type WorkflowCall = z.infer<typeof WorkflowCallSchema>
export const WorkflowBatchSchema = z.object({
  id,
  complete: z.boolean(),
  calls: z.array(WorkflowCallSchema),
})
export const WorkflowSnapshotSchema = z.object({
  chatId: id,
  rootChatId: id,
  epochId: id.optional(),
  contextStageId: id,
  runId: id.optional(),
  revision: count,
  status: WorkflowStatusSchema,
  waitReason: z.enum(['model', 'approval', 'answer', 'child', 'retry']).optional(),
  activeNodeId: WorkflowNodeIdSchema.optional(),
  phaseLabel: z.string().max(200).optional(),
  compactRequested: z.boolean().optional(),
  iteration: count.optional(),
  attempt: count.optional(),
  visitedNodeIds: z.array(WorkflowNodeIdSchema),
  batch: WorkflowBatchSchema.optional(),
  dispatches: z.array(
    z.object({
      id,
      name: z.string(),
      status: z.enum(['waiting', 'returned', 'failed', 'cancelled']),
    }),
  ),
  resources: WorkflowResourcesSchema,
  modelHooks: z.object({ before: z.boolean(), after: z.boolean() }).optional(),
  phaseKnown: z.boolean(),
  historyComplete: z.boolean(),
})
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>
export const WorkflowOpenRequestSchema = z.object({ chatId: id, observerId: id }).strict()
export const WorkflowOpenResponseSchema = z.object({
  subscriptionId: id,
  streamId: id,
  snapshot: WorkflowSnapshotSchema,
})
export const WorkflowCloseRequestSchema = z.object({ subscriptionId: id }).strict()
export const WorkflowCloseResponseSchema = z.object({ subscriptionId: id, closed: z.boolean() })
export const WorkflowUpdatedSchema = WorkflowOpenResponseSchema
export type WorkflowOpenRequest = z.infer<typeof WorkflowOpenRequestSchema>
export type WorkflowOpenResponse = z.infer<typeof WorkflowOpenResponseSchema>
export type WorkflowCloseRequest = z.infer<typeof WorkflowCloseRequestSchema>
export type WorkflowCloseResponse = z.infer<typeof WorkflowCloseResponseSchema>
export type WorkflowUpdated = z.infer<typeof WorkflowUpdatedSchema>

export const WorkflowHistoryRequestSchema = z
  .object({
    chatId: id,
    contextStageId: id.optional(),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict()
export const WorkflowFactSchema = z.object({
  id,
  nodeId: WorkflowNodeIdSchema,
  label: z.string().max(200),
  status: WorkflowStatusSchema,
  runId: id.optional(),
  batch: WorkflowBatchSchema.optional(),
  callId: id.optional(),
  dispatches: WorkflowSnapshotSchema.shape.dispatches.optional(),
  resources: WorkflowResourcesSchema.optional(),
  orderKey: count,
  orderQuality: z.enum(['exact', 'reconstructed']),
})
export type WorkflowFact = z.infer<typeof WorkflowFactSchema>
export const WorkflowHistoryResponseSchema = z.object({
  chatId: id,
  contextStageId: id,
  boundary: count,
  stages: z.array(z.object({ id, label: z.string(), quality: z.enum(['exact', 'reconstructed']) })),
  facts: z.array(WorkflowFactSchema),
  nextCursor: z.string().optional(),
  complete: z.boolean(),
  historyComplete: z.boolean(),
  resources: WorkflowResourcesSchema,
})
export type WorkflowHistoryRequest = z.infer<typeof WorkflowHistoryRequestSchema>
export type WorkflowHistoryResponse = z.infer<typeof WorkflowHistoryResponseSchema>
