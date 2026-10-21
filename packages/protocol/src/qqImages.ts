import { z } from 'zod'

const id = z.string().min(1).max(256)
const qq = z.string().regex(/^[1-9]\d{0,19}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const QQImageLimitsSchema = z.object({
  singleBytes: integer.positive().max(20971520).default(20971520),
  totalBytes: integer.positive().max(2147483648).default(2147483648),
  perTargetBytes: integer.positive().max(268435456).default(268435456),
}).strict()
/** Transport coordination bounds, not user/model task policy. */
export const QQImageAcquisitionMs = 120000
export const QQImageQueueCapacity = 32
export const QQImageSourceBudgetMs = (QQImageQueueCapacity + 1) * QQImageAcquisitionMs
export const QQImagePolicyDefault = { singleBytes: 20971520, totalBytes: 2147483648, perTargetBytes: 268435456 }
export const QQImageScopeIdentitySchema = z.object({
  backendEpoch: id, connectionGeneration: id, sessionId: id, selfId: qq,
  appliedRevision: integer, scopeDigest: hash,
}).strict()
export const QQImageScopeSchema = QQImageScopeIdentitySchema.extend({
  schemaVersion: z.literal(1), enabled: z.boolean(),
  allowedTargets: z.array(z.object({conversationType:z.enum(['group','private']),targetId:qq}).strict()).max(1100),
  targets: z.array(z.object({ conversationType: z.enum(['group', 'private']), targetId: qq, bindingId: id }).strict()).max(1100),
  limits: QQImageLimitsSchema,
}).strict()
export type QQImageScope = z.infer<typeof QQImageScopeSchema>
export const QQImageSourceSchema = z.object({
  conversationType: z.enum(['group', 'private']), targetId: qq, senderId: qq,
  nativeMsgId: id, elementOrdinal: integer.max(29), elementId: id, fileUuid: id,
  messageId: z.string().regex(/^-?\d{1,100}$/), occurredAt: integer,
  size: integer.positive().max(20971520), nativeMd5: z.string().regex(/^[a-fA-F0-9]{32}$/),
}).strict().superRefine((v, ctx) => {
  if (v.conversationType === 'private' && v.targetId !== v.senderId) ctx.addIssue({code: 'custom', message: 'Invalid private source'})
})
export type QQImageSource = z.infer<typeof QQImageSourceSchema>
const authority = { scope: QQImageScopeIdentitySchema, sourceEventId: id, permitId: id }
const upload = { ...authority, uploadId: id }
const result = z.object({ state: z.enum(['registered', 'queued', 'uploading', 'committed', 'aborted']), nextOffset: integer,
  uploadId: id.optional(), assetId: id.optional(), assetVersionId: id.optional() }).strict()
export const QQImageRequestSchemas = {
  'qq.image.scope.get': z.object({ selfId: qq }).strict(),
  'qq.image.scope.ack': QQImageScopeIdentitySchema,
  'qq.image.source.register': z.object({ scope: QQImageScopeIdentitySchema, source: QQImageSourceSchema, deadlineAt: integer.optional() }).strict(),
  'qq.image.ingest.begin': z.object({ ...authority, size: integer.positive().max(20971520), sha256: hash, mimeType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']) }).strict(),
  'qq.image.ingest.chunk': z.object({ ...upload, offset: integer, dataBase64: z.string().min(4).max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  'qq.image.ingest.status': z.object(authority).strict(),
  'qq.image.ingest.commit': z.object({ ...upload, size: integer.positive().max(20971520), sha256: hash }).strict(),
  'qq.image.ingest.cancel': z.object({ ...upload, reason: z.enum(['scope_changed', 'disconnected', 'source_unavailable', 'stopped']) }).strict(),
} as const
export const QQImageResponseSchemas = {
  'qq.image.scope.get': QQImageScopeSchema,
  'qq.image.scope.ack': z.object({ acknowledged: z.literal(true) }).strict(),
  'qq.image.source.register': z.object({ sourceEventId: id, permitId: id }).strict(),
  'qq.image.ingest.begin': result,
  'qq.image.ingest.chunk': z.object({ nextOffset: integer }).strict(),
  'qq.image.ingest.status': result,
  'qq.image.ingest.commit': result,
  'qq.image.ingest.cancel': z.object({ cancelled: z.boolean() }).strict(),
} as const
export const QQImageTransportMethods = Object.keys(QQImageRequestSchemas) as Array<keyof typeof QQImageRequestSchemas>
export const QQImageScopeNotificationSchema = z.object({ kind: z.literal('notification'), type: z.literal('qq.image.scope'), data: QQImageScopeSchema }).strict()
