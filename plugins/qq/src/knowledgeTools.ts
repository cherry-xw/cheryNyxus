import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'
import { TermInputSchema } from './knowledge.js'
import { withOperations, operationId } from './operationPolicy.js'
type Registration = Parameters<IngressContext['tools']['register']>[0]
export const MemorySearchSchema = z.object({ query: z.string().max(2000), scope: z.enum(['local','public','both']).default('both'), limit: z.number().int().min(1).max(20).default(8) }).strict()
export const MemoryManageSchema = z.union([
  z.object({ scope: z.literal('local'), operationId, expectedRevision: z.number().int().nonnegative(), save: z.array(TermInputSchema).max(20).default([]),
    delete: z.array(z.string()).max(100).default([]), reject: z.array(z.string()).max(100).default([]), restore: z.array(z.string()).max(100).default([]) }).strict(),
  z.object({ scope: z.literal('public'), action: z.literal('submit_candidate'), operationId, evidenceRefs: z.array(z.string()).min(1).max(20) }).strict(),
  z.object({ scope: z.literal('public'), action: z.literal('adopt_candidate'), operationId, candidateId: z.string().min(1).max(160) }).strict(),
])
export function knowledgeTools(run: (requestId: string, method: 'search'|'manage', args: any, signal?: AbortSignal) => Promise<unknown>): Registration[] {
  return ([['qq_memory_search',MemorySearchSchema,'查找当前对话长期记忆和同一机器人公共词义；scope=local/public/both。完整词项匹配，空查询不返回全部；可改写query查找。返回revision、来源、匹配词和不确定性。'],
    ['qq_memory_manage',MemoryManageSchema,'记忆维护必须operationId，重试不换ID。local按expectedRevision批量save/delete，save引用当前真实来源recordId，reject/restore按公共条目ID改变本范围采用状态；纠正保留分歧。public只能提交本次已读网页evidenceRefs或采用completed候选candidateId，不能直接写公共释义或删除公共条目。学习关闭禁止公共提交/采用，仍允许明确本地维护。']] as const).map(([name,schema,description]) => {
    const registration: Registration = { sense: { definition: { type: 'function', function: { name, description, parameters: { type: 'object', ...z.toJSONSchema(schema) } as any } },
      supervisionLevel: 0, executor: { schema, execute: async (input,_shared,ctx) => {
        const view = ctx?.requestView
        if (view?.identity.source !== 'plugin' || view.identity.channel !== 'qq') throw new Error('NOT_ALLOWED')
        try { return { content: JSON.stringify(await run(view.requestId,name === 'qq_memory_search' ? 'search' : 'manage',schema.parse(input),ctx?.signal)), status: 'ok' } }
        catch (error) { return { content: JSON.stringify({ ok:false, code:(error as {code?:string}).code ?? 'FAILED', message:'记忆操作未完成，不得宣称已经保存或没有资料', retryable:false }), status:'provider_error', errorCode:'provider_error' } }
      } } }, metadata: { label:name,description,icon:'qq',doc:description } }
    return name === 'qq_memory_manage' ? withOperations(registration,'scope',['local','public']) : registration
  })
}
