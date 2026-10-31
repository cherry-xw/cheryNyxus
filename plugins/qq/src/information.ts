import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'
import { withOperations } from './operationPolicy.js'
type Registration = Parameters<IngressContext['tools']['register']>[0]
const count = z.number().int().min(1).max(100).default(50)
const userId = z.string().regex(/^[1-9]\d{0,19}$/)
const resource = z.string().min(1).max(256).refine(value => !/[\x00-\x1f]/.test(value))
export const informationSchema = z.discriminatedUnion('kind', [
  ...(['profile','member'] as const).map(kind => z.object({ kind: z.literal(kind), count, userId }).strict()),
  z.object({ kind: z.literal('members'), count, query: z.string().max(100).optional() }).strict(),
  z.object({ kind: z.literal('voices'), count, query: z.string().max(100).optional() }).strict(),
  z.object({ kind: z.literal('files'), count, folderId: resource.optional() }).strict(),
  z.object({ kind: z.literal('file_url'), count, fileId: resource }).strict(),
  z.object({ kind: z.literal('album_media'), count, albumId: resource }).strict(),
  ...(['group','notices','file_space','essence','albums','honor'] as const).map(kind => z.object({ kind: z.literal(kind), count }).strict()),
])
export const historySchema = z.object({ source: z.enum(['retained','platform']).default('retained'), count,
  cursor: z.string().min(1).max(256).optional() }).strict().superRefine((input, ctx) => {
  if (input.source === 'platform' && input.cursor) ctx.addIssue({ code: 'custom', path: ['cursor'], message: '平台历史不接受本地游标' })
})
export type InformationQuery = z.infer<typeof informationSchema> | { kind: 'history'; count: number; historySource: 'retained' | 'platform'; cursor?: string }
function queryTool(name: string, schema: z.ZodType, description: string, run: (id: string, input: any) => Promise<unknown>): Registration {
  return { sense: { definition: { type: 'function', function: { name, description, parameters: { type: 'object', ...z.toJSONSchema(schema) } as any } }, supervisionLevel: 0,
    executor: { schema, execute: async (input, _shared, ctx) => {
      const view = ctx?.requestView
      if (view?.identity.source !== 'plugin' || view.identity.channel !== 'qq' || !view.identity.subject) throw new Error('Trusted QQ request required')
      ctx?.signal?.throwIfAborted()
      try { const result = await run(view.requestId, schema.parse(input)); ctx?.signal?.throwIfAborted(); return { status: 'ok', content: JSON.stringify(result) } }
      catch (error) { const code = (error as {code?:string})?.code; return { status: 'provider_error', errorCode: 'provider_error', content: JSON.stringify({ ok: false, code: code || 'FAILED', message: '查询未完成，不能据此断定没有资料', retryable: !code }) } }
    } } }, metadata: { label: name, description, icon: 'qq', doc: description } }
}
export function informationTools(run: (id: string, input: InformationQuery) => Promise<unknown>): Registration[] {
  return [withOperations(queryTool('qq_information', informationSchema, '当前QQ范围只读资料查询。成员与声音可按真实ID/昵称query查找；重名须确认。profile/member必须提供真实userId，file_url必须fileId，album_media必须albumId。私聊仅允许本人profile。不含历史和维护操作。', run), 'kind', ['profile','member','members','voices','files','file_url','album_media','group','notices','file_space','essence','albums','honor']),
    queryTool('qq_history', historySchema, '读取当前范围历史，source默认retained；按nextCursor继续更早页。platform仅群聊，无游标。长文字通过qq_source_text_read分页；附件元信息不代表已读内容。', (id, input) => run(id, { kind: 'history', count: input.count, historySource: input.source, cursor: input.cursor }))]
}
export function sourceTextTool(run: (id: string, input: { textRefId: string; cursor?: string }) => Promise<unknown>): Registration {
  return queryTool('qq_source_text_read', z.object({ textRefId: z.string().min(1).max(256), cursor: z.string().min(1).max(256).optional() }).strict(),
    '读取qq_history返回的固定文字引用，只在当前运行和范围有效。每段最多8192个Unicode字符，传nextCursor继续；不读取图片或任意路径。', run)
}
