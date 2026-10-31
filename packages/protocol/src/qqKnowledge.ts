import { z } from 'zod'
const target = z.string().regex(/^(?:group:|private:user:)[1-9]\d{0,19}$/)
const id = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/)
const label = z.string().trim().min(1).max(80)
export const QQTermInputSchema = z.object({ id, term: label, aliases: z.array(label).max(20).default([]),
  meaning: z.string().trim().min(1).max(1000), usage: z.string().max(1000).default(''), caveat: z.string().max(500).default(''),
  status: z.enum(['active','disputed','superseded','inactive']).default('active'), evidenceRefs: z.array(id).min(1).max(20),
  kind: z.enum(['fact','agreement','experience','preference','term']).default('term'), members: z.array(z.string().regex(/^[1-9]\d{0,19}$/)).max(20).default([]),
}).strict()
export const QQKnowledgeRequestSchemas = {
  'qq.knowledge.list': z.object({ target, scope:z.enum(['local','public']), cursor:z.string().max(4096).optional(),
    revision:z.coerce.number().int().nonnegative().optional(),count:z.coerce.number().int().min(1).max(100).default(20) }).strict(),
  'qq.knowledge.edit': z.object({ target,scope:z.enum(['local','public']),operationId:id,expectedRevision:z.number().int().nonnegative(),
    save:z.array(QQTermInputSchema).max(20).default([]),delete:z.array(id).max(100).default([]),reject:z.array(id).max(100).default([]),restore:z.array(id).max(100).default([]),
    adminNote:z.string().trim().min(1).max(1000) }).strict(),
  'qq.learning.get':z.object({}).strict(),
  'qq.learning.retry':z.object({operationId:id}).strict(),
}
export const QQKnowledgeResponseSchemas = {
  'qq.knowledge.list':z.object({revision:z.number(),entries:z.array(z.record(z.string(),z.unknown())),rejected:z.array(z.string()),total:z.number(),nextCursor:z.string().nullable()}).strict(),
  'qq.knowledge.edit':z.object({fingerprint:z.string(),revision:z.number(),saved:z.number(),deleted:z.number()}).strict(),
  'qq.learning.get':z.object({pending:z.number(),usedCalls:z.number(),limit:z.number(),reason:z.string().nullable(),tasks:z.array(z.record(z.string(),z.unknown()))}).strict(),
  'qq.learning.retry':z.object({queued:z.literal(true)}).strict(),
}
