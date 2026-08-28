import { z } from 'zod'
import { Method } from './rpc'

/** Canonical chat methods. Legacy stream/replay methods intentionally do not live here. */
export const ChatMethod = {
  OPEN: Method.CHAT_OPEN,
  CLOSE: Method.CHAT_CLOSE,
  LIST: Method.CHAT_LIST,
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

export const ChatAttachmentSchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(['image', 'video', 'audio']),
  mimeType: z.string().min(1),
})
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>

export const ChatInputSubmitRequestSchema = z.object({
  chatId: z.string().min(1),
  commandId: z.string().min(1),
  clientMessageId: z.string().min(1),
  messageId: z.string().min(1),
  content: z.string(),
  attachments: z.array(ChatAttachmentSchema).optional(),
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
