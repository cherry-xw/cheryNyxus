import { z } from 'zod'

const id = z.string().min(1).max(256)
const count = z.number().int().nonnegative()

/**
 * Detailed workflow facts are intentionally separate from the legacy ten-node
 * snapshot below. A template kind describes a possible slot; an occurrence is
 * created only after the corresponding runtime boundary actually happened.
 */
export const WorkflowStepKindSchema = z.enum([
  'submission',
  'queue',
  'context',
  'command',
  'input',
  'request',
  'model',
  'retry',
  'tool-list',
  'tool-validation',
  'tool-authorization',
  'tool-approval',
  'tool-preflight',
  'tool-execution',
  'tool-result',
  'checkpoint',
  'loop-decision',
  'dispatch',
  'child-run',
  'child-return',
  'parent-receive',
  'wake',
  'compact-request',
  'compact-summary',
  'compact-applied',
  'result',
  'unknown',
])
export type WorkflowStepKind = z.infer<typeof WorkflowStepKindSchema>

export const WorkflowOccurrenceStatusSchema = z.enum([
  'running',
  'waiting',
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'interrupted',
  'unknown',
])
export type WorkflowOccurrenceStatus = z.infer<typeof WorkflowOccurrenceStatusSchema>

export const WorkflowWaitReasonSchema = z.enum([
  'model',
  'approval',
  'answer',
  'child',
  'retry',
  'queue',
])
export type WorkflowWaitReason = z.infer<typeof WorkflowWaitReasonSchema>

export const WorkflowStepReasonSchema = z.enum([
  'accepted',
  'queued',
  'consumed',
  'restored',
  'reused',
  'request',
  'response',
  'validation',
  'policy',
  'approval',
  'preflight',
  'execution',
  'result',
  'backoff',
  'limit',
  'normal',
  'error',
  'user',
  'system',
  'disconnect',
  'timeout',
  'unavailable',
  'legacy',
  'unknown',
])
export type WorkflowStepReason = z.infer<typeof WorkflowStepReasonSchema>

export const WorkflowContentAnchorSchema = z
  .object({
    kind: z.enum(['message', 'tool-call', 'branch', 'compaction', 'execution-node']),
    id,
    chatId: id.optional(),
  })
  .strict()
export type WorkflowContentAnchor = z.infer<typeof WorkflowContentAnchorSchema>

export const WorkflowStepEventKindSchema = z.enum([
  'started',
  'status',
  'anchor-added',
  'parent-linked',
  'cause-linked',
  'gap',
])
export type WorkflowStepEventKind = z.infer<typeof WorkflowStepEventKindSchema>

export const WorkflowStepEventSchema = z.object({
  eventId: id,
  occurrenceId: id,
  rootChatId: id,
  chatId: id,
  sequence: count,
  revision: count,
  eventKind: WorkflowStepEventKindSchema,
  kind: WorkflowStepKindSchema,
  label: z.string().min(1).max(200),
  status: WorkflowOccurrenceStatusSchema.optional(),
  waitReason: WorkflowWaitReasonSchema.optional(),
  reason: WorkflowStepReasonSchema.optional(),
  taskId: id.optional(),
  branchId: id.optional(),
  contextStageId: id,
  runId: id.optional(),
  iteration: count.optional(),
  attempt: count.optional(),
  batchId: id.optional(),
  callId: id.optional(),
  parentOccurrenceId: id.optional(),
  causeOccurrenceId: id.optional(),
  anchor: WorkflowContentAnchorSchema.optional(),
  at: count,
  orderQuality: z.enum(['exact', 'reconstructed']),
})
export type WorkflowStepEvent = z.infer<typeof WorkflowStepEventSchema>

export const WorkflowOccurrenceSchema = z.object({
  occurrenceId: id,
  rootChatId: id,
  chatId: id,
  taskId: id.optional(),
  branchId: id.optional(),
  contextStageId: id,
  runId: id.optional(),
  iteration: count.optional(),
  attempt: count.optional(),
  batchId: id.optional(),
  callId: id.optional(),
  parentOccurrenceId: id.optional(),
  causeOccurrenceId: id.optional(),
  kind: WorkflowStepKindSchema,
  label: z.string().min(1).max(200),
  status: WorkflowOccurrenceStatusSchema,
  waitReason: WorkflowWaitReasonSchema.optional(),
  reason: WorkflowStepReasonSchema.optional(),
  anchors: z.array(WorkflowContentAnchorSchema),
  startedAt: count,
  updatedAt: count,
  endedAt: count.optional(),
  firstSequence: count,
  lastSequence: count,
  orderQuality: z.enum(['exact', 'reconstructed']),
})
export type WorkflowOccurrence = z.infer<typeof WorkflowOccurrenceSchema>

export const WorkflowGapSchema = z.object({
  gapId: id,
  rootChatId: id,
  fromSequence: count,
  toSequence: count,
  chatId: id.optional(),
  runId: id.optional(),
  contextStageId: id.optional(),
  reason: z.enum(['recorder-overflow', 'write-failed', 'process-interrupted', 'legacy', 'unknown']),
})
export type WorkflowGap = z.infer<typeof WorkflowGapSchema>

export const WorkflowStepSnapshotSchema = z.object({
  rootChatId: id,
  revision: count,
  upperSequence: count,
  active: z.array(WorkflowOccurrenceSchema),
  recentEvents: z.array(WorkflowStepEventSchema),
  gaps: z.array(WorkflowGapSchema),
  hasEarlier: z.boolean(),
  historyComplete: z.boolean(),
})
export type WorkflowStepSnapshot = z.infer<typeof WorkflowStepSnapshotSchema>
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
