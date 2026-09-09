import { z } from 'zod'

export const ArchiveListRequestSchema = z
  .object({
    query: z.string().max(300).optional(),
    presetId: z.string().max(300).optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
  })
  .strict()

export const ArchiveChatSchema = z.object({
  chatId: z.string().min(1),
  parentChatId: z.string().nullable(),
  presetId: z.string().optional(),
  preset: z.string().optional(),
  agentType: z.string().optional(),
  avatar: z.string().optional(),
  preview: z.string(),
  messageCount: z.number().int().nonnegative(),
  branchKind: z.enum(['original', 'continuation', 'detail']).optional(),
})

export const ArchiveGroupSchema = z.object({
  rootChatId: z.string().min(1),
  archivedAt: z.number().optional(),
  archiveReason: z.string().optional(),
  chats: z.array(ArchiveChatSchema),
})

export const ArchiveListResponseSchema = z.object({
  groups: z.array(ArchiveGroupSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  presets: z.array(z.object({ id: z.string(), label: z.string() })),
})

export const ChatLifecycleChangedSchema = z.object({
  action: z.enum(['archived', 'deleted']),
  chatIds: z.array(z.string().min(1)),
})

export type ArchiveListRequest = z.infer<typeof ArchiveListRequestSchema>
export type ArchiveListResponse = z.infer<typeof ArchiveListResponseSchema>
export type ArchiveGroup = z.infer<typeof ArchiveGroupSchema>
export type ArchiveChat = z.infer<typeof ArchiveChatSchema>
export type ChatLifecycleChanged = z.infer<typeof ChatLifecycleChangedSchema>
