import { z } from 'zod'
import { Method } from './rpc'

export const TerminationCode = {
  USER_ABORT: 'user_abort',
  SYSTEM_STOP: 'system_stop',
  WATCHDOG: 'watchdog',
  ERROR: 'error',
  AGENT_REDIRECT: 'agent_redirect',
  LIMIT_REACHED: 'limit_reached',
} as const
export type TerminationCode = (typeof TerminationCode)[keyof typeof TerminationCode]

export interface TerminationFact {
  actor: 'user' | 'system' | 'agent'
  code: TerminationCode
  at: number
  detail?: string
  controlOperationId?: string
}

/** Canonical chat methods. Legacy stream/replay methods intentionally do not live here. */
export const ChatMethod = {
  OPEN: Method.CHAT_OPEN,
  CLOSE: Method.CHAT_CLOSE,
  OVERVIEW_OPEN: Method.CHAT_OVERVIEW_OPEN,
  OVERVIEW_CLOSE: Method.CHAT_OVERVIEW_CLOSE,
  LIST: Method.CHAT_LIST,
  TASK_LIST: Method.CHAT_TASK_LIST,
  TASK_RESULT_VIEW: Method.CHAT_TASK_RESULT_VIEW,
  TIMELINE_GET: Method.CHAT_TIMELINE_GET,
  TIMELINE_GENERATION_GET: Method.CHAT_TIMELINE_GENERATION_GET,
  TIMELINE_NODE_GET: Method.CHAT_TIMELINE_NODE_GET,
  INPUT_SUBMIT: Method.CHAT_INPUT_SUBMIT,
  RUN_RESUME: Method.CHAT_RUN_RESUME,
  ABORT: Method.CHAT_ABORT,
  RESUME_TREE: Method.CHAT_RESUME_TREE,
} as const

const openBase = {
  knownTimelineRevision: z.number().int().nonnegative().optional(),
  knownEventSeq: z.number().int().nonnegative().optional(),
  executionStepLimit: z.number().int().positive().max(500).optional(),
}

export const ChatOpenRequestSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('chat'), chatId: z.string().min(1), ...openBase }),
  z.object({
    scope: z.literal('root'),
    rootChatId: z.string().min(1),
    view: z.enum(['conversation', 'tree']).default('conversation'),
    ...openBase,
  }),
])

export type ChatOpenRequest = z.infer<typeof ChatOpenRequestSchema>

export const ChatCloseRequestSchema = z.object({ subscriptionId: z.string().min(1) })
export type ChatCloseRequest = z.infer<typeof ChatCloseRequestSchema>

/** One monotonic sequence belongs to one direct/root subscription. */
export interface ChatSubscriptionEvent<TPayload = unknown> {
  subscriptionId: string
  scopeId: string
  eventSeq: number
  type: string
  payload: TPayload
}

export const ChatRunResumeRequestSchema = z.object({
  chatId: z.string().min(1),
  commandId: z.string().min(1),
})
export type ChatRunResumeRequest = z.infer<typeof ChatRunResumeRequestSchema>

export interface ChatRunResumeResponse {
  chatId: string
  commandId: string
  runId: string
  status: 'started' | 'already-running'
}

export const AssetKindSchema = z.enum(['image', 'audio', 'video', 'document', 'file'])
export type AssetKind = z.infer<typeof AssetKindSchema>

export const AssetVariantSchema = z.enum(['original', 'adapted'])
export type AssetVariant = z.infer<typeof AssetVariantSchema>

export const AssetUsageSchema = z.enum(['content', 'reference-only'])
export type AssetUsage = z.infer<typeof AssetUsageSchema>

export const AssetSourceSchema = z.enum([
  'upload',
  'tool',
  'provider',
  'workspace',
  'migration',
])
export type AssetSource = z.infer<typeof AssetSourceSchema>

export interface AssetRecord {
  availability?: 'available' | 'missing' | 'unclaimed'
  id: string
  versionId: string
  originalName: string
  mimeType: string
  kind: AssetKind
  sizeBytes: number
  sha256: string
  createdAt: number
  source: AssetSource
  ownerId?: string
  chatId?: string
  parentAssetId?: string
  transform?: {
    variant: AssetVariant
    maxEdge?: number
    quality?: number
    width?: number
    height?: number
    preservedTransparency?: boolean
    preservedAnimation?: boolean
  }
}

export const AssetRecordSchema = z
  .object({
    id: z.string().min(1),
    versionId: z.string().min(1),
    availability: z.enum(['available', 'missing', 'unclaimed']).optional(),
    originalName: z.string().min(1),
    mimeType: z.string().min(1),
    kind: AssetKindSchema,
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
    createdAt: z.number(),
    source: AssetSourceSchema,
    ownerId: z.string().optional(),
    chatId: z.string().optional(),
    parentAssetId: z.string().optional(),
    transform: z
      .object({
        variant: AssetVariantSchema,
        maxEdge: z.number().int().positive().optional(),
        quality: z.number().int().min(1).max(100).optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        preservedTransparency: z.boolean().optional(),
        preservedAnimation: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const MessageTextPartSchema = z
  .object({
    partId: z.string().min(1),
    type: z.literal('text'),
    text: z.string(),
  })
  .strict()

export const MessageAssetPartSchema = z
  .object({
    partId: z.string().min(1),
    type: z.literal('asset'),
    availability: z.enum(['available', 'missing', 'unclaimed']).optional(),
    assetId: z.string().min(1),
    assetVersionId: z.string().min(1),
    variant: AssetVariantSchema.default('adapted'),
    usage: AssetUsageSchema.default('content'),
    caption: z.string().optional(),
    originalName: z.string().optional(),
    mimeType: z.string().optional(),
    kind: AssetKindSchema.optional(),
    /** Mechanical provenance; historical adoption must not refresh the image turn. */
    inputOrigin: z.enum(['history', 'quote']).optional(),
  })
  .strict()

export const MessageDirectivePartSchema = z
  .object({
    partId: z.string().min(1),
    type: z.literal('directive'),
    command: z.string().min(1),
    args: z.string().optional(),
  })
  .strict()

export const MessageRoleMentionPartSchema = z
  .object({
    partId: z.string().min(1),
    type: z.literal('role_mention'),
    roleName: z.string().min(1),
    roleId: z.string().optional(),
  })
  .strict()

export const MessageWorkspaceRefPartSchema = z
  .object({
    partId: z.string().min(1),
    type: z.literal('workspace_ref'),
    path: z.string().min(1),
    kind: z.enum(['file', 'directory']).optional(),
  })
  .strict()

export const MessagePartSchema = z.discriminatedUnion('type', [
  MessageTextPartSchema,
  MessageAssetPartSchema,
  MessageDirectivePartSchema,
  MessageRoleMentionPartSchema,
  MessageWorkspaceRefPartSchema,
])
export type MessagePart = z.infer<typeof MessagePartSchema>
export type MessageTextPart = z.infer<typeof MessageTextPartSchema>
export type MessageAssetPart = z.infer<typeof MessageAssetPartSchema>
export type MessageDirectivePart = z.infer<typeof MessageDirectivePartSchema>
export type MessageRoleMentionPart = z.infer<typeof MessageRoleMentionPartSchema>
export type MessageWorkspaceRefPart = z.infer<typeof MessageWorkspaceRefPartSchema>

export type FileOperationExecutionStatus =
  | 'waiting_approval'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'result_unknown'

export type FileOperationDeliveryStatus =
  | 'pending_save'
  | 'saving'
  | 'saved'
  | 'partial_saved'
  | 'delivery_failed'

export type FileOperationInspectionStatus =
  | 'not_requested'
  | 'pending_inspection'
  | 'passed'
  | 'failed_inspection'
  | 'inspection_error'

export interface FileOperationRecord {
  providerContinuation?: Record<string, unknown>
  operationId: string
  operation: import('./llm').FileCapabilityOperation
  inputAssets: Array<{ assetId: string; assetVersionId: string; variant?: AssetVariant }>
  params?: Record<string, unknown>
  question?: string
  targetKind: 'native' | 'tool' | 'role'
  targetId: string
  configRevision?: string
  sourceMessageId?: string
  sourceCallId?: string
  sourceTaskId?: string
  executionStatus: FileOperationExecutionStatus
  remoteStatus?: string
  deliveryStatus: FileOperationDeliveryStatus
  inspectionStatus: FileOperationInspectionStatus
  inspectionOperationId?: string
  inspectionSummary?: string
  outputParts?: MessagePart[]
  outputAssetIds?: string[]
  remoteJobId?: string
  error?: { code: string; message: string; retryable?: boolean }
  usage?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export const FileOperationRecordSchema = z
  .object({
    providerContinuation: z.record(z.string(), z.unknown()).optional(),
    operationId: z.string().min(1),
    operation: z.enum([
      'image.inspect',
      'image.generate',
      'image.reference',
      'image.edit',
      'document.extract',
      'audio.transcribe',
      'video.inspect',
    ]),
    inputAssets: z.array(
      z
        .object({
          assetId: z.string().min(1),
          assetVersionId: z.string().min(1),
          variant: AssetVariantSchema.optional(),
        })
        .strict(),
    ),
    params: z.record(z.string(), z.unknown()).optional(),
    question: z.string().optional(),
    targetKind: z.enum(['native', 'tool', 'role']),
    targetId: z.string().min(1),
    configRevision: z.string().optional(),
    sourceMessageId: z.string().optional(),
    sourceCallId: z.string().optional(),
    sourceTaskId: z.string().optional(),
    executionStatus: z.enum([
      'waiting_approval',
      'queued',
      'running',
      'succeeded',
      'partial',
      'failed',
      'cancel_requested',
      'cancelled',
      'result_unknown',
    ]),
    remoteStatus: z.string().optional(),
    deliveryStatus: z.enum([
      'pending_save',
      'saving',
      'saved',
      'partial_saved',
      'delivery_failed',
    ]),
    inspectionStatus: z.enum([
      'not_requested',
      'pending_inspection',
      'passed',
      'failed_inspection',
      'inspection_error',
    ]),
    inspectionOperationId: z.string().min(1).optional(),
    inspectionSummary: z.string().min(1).optional(),
    outputParts: z.array(MessagePartSchema).optional(),
    outputAssetIds: z.array(z.string()).optional(),
    remoteJobId: z.string().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean().optional(),
      })
      .strict()
      .optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict()

/** 实时通知、回放与历史共用的工具文件结果。 */
export const ToolFileResultSchema = z.object({
  parts: z.array(MessagePartSchema).optional(),
  fileOperations: z.array(FileOperationRecordSchema).optional(),
})
export type ToolFileResult = z.infer<typeof ToolFileResultSchema>

/** 从有序 parts 派生纯文本投影（供搜索、预览或旧纯文本算法读取）。 */
export function deriveTextContentFromParts(parts: readonly MessagePart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text
        case 'asset':
          return part.caption
            ? `[文件: ${part.originalName ?? part.assetId} (${part.caption})]`
            : `[文件: ${part.originalName ?? part.assetId}]`
        case 'directive':
          return `[[command:${part.command}${part.args ? ` ${part.args}` : ''}]]`
        case 'role_mention':
          return `@${part.roleName}`
        case 'workspace_ref':
          return `@${part.path}`
      }
    })
    .join('')
}

export const ChatAttachmentSchema = z.object({
  assetId: z.string().min(1),
  assetVersionId: z.string().min(1).optional(),
  kind: AssetKindSchema,
  mimeType: z.string().min(1),
  variant: AssetVariantSchema.optional(),
  usage: AssetUsageSchema.optional(),
  originalName: z.string().optional(),
})
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>

export const ChatInputSubmitRequestSchema = z
  .object({
    chatId: z.string().min(1),
    commandId: z.string().min(1),
    clientMessageId: z.string().min(1),
    messageId: z.string().min(1),
    content: z.string().optional(),
    parts: z.array(MessagePartSchema).optional(),
    attachments: z.array(ChatAttachmentSchema).optional(),
  })
  .strict()
  .refine((v) => v.content !== undefined || (v.parts !== undefined && v.parts.length > 0), {
    message: 'content 或 parts 至少提供一个',
  })
export type ChatInputSubmitRequest = z.infer<typeof ChatInputSubmitRequestSchema>

export interface ChatInputSubmitResponse {
  chatId: string
  inputId: string
  clientMessageId: string
  messageId: string
  runId: string
  state: 'started' | 'queued'
  queueSequence: number
  acceptedAt: number
}

export const ChatInputWithdrawRequestSchema = z
  .object({
    chatId: z.string().min(1),
    commandId: z.string().min(1),
    inputId: z.string().min(1).optional(),
    clientMessageId: z.string().min(1).optional(),
  })
  .refine((value) => !!value.inputId || !!value.clientMessageId, {
    message: 'inputId 或 clientMessageId 至少提供一个',
  })
export type ChatInputWithdrawRequest = z.infer<typeof ChatInputWithdrawRequestSchema>

export interface ChatInputWithdrawResponse {
  chatId: string
  inputId: string
  clientMessageId: string | null
  messageId: string
  state: 'cancelled'
  withdrawnAt: number
}

export const ChatTimelineGetRequestSchema = z
  .object({
    chatId: z.string().min(1).optional(),
    rootChatId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    view: z.enum(['conversation', 'tree', 'audit']).optional(),
    before: z.union([z.string(), z.number()]).optional(),
    limit: z.number().int().positive().max(500).optional(),
    knownRevision: z.number().int().nonnegative().optional(),
  })
  .refine((value) => !!value.chatId || !!value.rootChatId || !!value.taskId, {
    message: 'chatId、rootChatId 或 taskId 至少提供一个',
  })
export type ChatTimelineGetRequest = z.infer<typeof ChatTimelineGetRequestSchema>

/** Transport envelope shared by backend and clients; domain payloads remain generic. */
export interface ChatTimelineResponse<TMessage, TRootTimeline> {
  chatId: string
  revision: number
  messages?: TMessage[]
  rootTimeline?: TRootTimeline
  nextCursor?: string
  eventSeq?: number
  unchanged?: boolean
}

/** Atomic subscription boundary. State and root projection types are domain-owned payloads. */
export interface ChatOpenResponse<TState, TRootTimeline = never> {
  chatId: string
  subscriptionId: string
  eventSeq: number
  timelineRevision: number
  timelineChanged: boolean
  timelineUnchanged?: boolean
  rootTimeline?: TRootTimeline
  state: TState
}
