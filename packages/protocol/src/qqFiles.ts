import { z } from 'zod'

const id = z.string().min(1).max(256)
const qq = z.string().regex(/^[1-9]\d{0,19}$/)
const integer = z.number().int().nonnegative().safe()
const bytes = integer.positive().max(104857600)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const source = { selfId: qq, eventId: id, partId: z.string().regex(/^p\d+(?:\.\d+)?$/) }
const upload = { ...source, uploadId: id }
const status = z.object({
  state: z.enum(['queued', 'uploading', 'committed', 'aborted', 'not_found']), nextOffset: integer,
  uploadId: id.optional(), assetId: id.optional(), assetVersionId: id.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.state === 'committed' && (!value.assetId || !value.assetVersionId))
    ctx.addIssue({ code: 'custom', message: 'Missing fixed file identity' })
})
export const QQFileRequestSchemas = {
  'qq.source.file.reserve': z.object({ ...source, size: bytes }).strict(),
  'qq.source.file.begin': z.object({ ...source, size: bytes, sha256: hash }).strict(),
  'qq.source.file.chunk': z.object({ ...upload, offset: integer, dataBase64: z.string().min(4).max(87384) }).strict(),
  'qq.source.file.commit': z.object({ ...upload, size: bytes, sha256: hash }).strict(),
  'qq.source.file.status': z.object(source).strict(),
  'qq.source.file.cancel': z.object(upload).strict(),
  'qq.source.file.import': z.object({ ...source, url: z.string().url().max(8192).refine(value => {
    const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password
  }) }).strict(),
  'qq.source.file.unavailable': z.object({ ...source, reasonCode: z.enum(['FILE_DOWNLOAD_FAILED', 'FILE_INVALID', 'FILE_TOO_LARGE', 'SOURCE_UNAVAILABLE']) }).strict(),
} as const
export const QQFileResponseSchemas = {
  'qq.source.file.reserve': status,
  'qq.source.file.begin': status,
  'qq.source.file.chunk': z.object({ nextOffset: integer }).strict(),
  'qq.source.file.commit': status,
  'qq.source.file.status': status,
  'qq.source.file.cancel': z.object({ cancelled: z.boolean() }).strict(),
  'qq.source.file.import': status,
  'qq.source.file.unavailable': z.object({ recorded: z.literal(true) }).strict(),
} as const
export const QQFileTransportMethods = Object.keys(QQFileRequestSchemas) as Array<keyof typeof QQFileRequestSchemas>
