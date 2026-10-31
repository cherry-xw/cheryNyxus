import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'
import { SourceRecordRefSchema } from '@chery/protocol'

export const participationSchema = z.object({
  action: z.enum(['reply', 'wait', 'end']),
  batchId: z.string().min(1).max(256),
  reason: z.string().max(300),
  anchorRecord: SourceRecordRefSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === 'reply') !== !!value.anchorRecord) ctx.addIssue({ code: 'custom', path: ['anchorRecord'], message: 'reply必须选择真实来源；其他动作不得选择来源' })
})
export type ParticipationDecision = z.infer<typeof participationSchema>

export function participationTool(decide: (requestId: string, input: ParticipationDecision) => void): Parameters<IngressContext['tools']['register']>[0] {
  const parameters = { type: 'object' as const, properties: {
    action: { type: 'string', enum: ['reply', 'wait', 'end'] },
    batchId: { type: 'string', minLength: 1, maxLength: 256, description: '原样复制本轮qq.discussion.batchId；不要改用snapshotId、核心运行编号或历史批次编号' },
    reason: { type: 'string', maxLength: 300 },
    anchorRecord: { type: 'object', description: 'reply必填，原样复制本轮qq.discussion.candidates中的一个{recordId,revision}；wait/end不传',
      properties: { recordId: { type: 'string', minLength: 1, maxLength: 256 }, revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      required: ['recordId', 'revision'], additionalProperties: false },
  }, required: ['action', 'batchId', 'reason'], additionalProperties: false }
  return {
    sense: {
      definition: { type: 'function', function: {
        name: 'qq_participation_decide',
        description: 'QQ内部参与判断。只有qq.discussion提供decisionRequired时调用。判断是否真的需要助手参与，而非只判断话题相关。reply继续回答，wait暂不插话，end讨论结束。batchId必须原样复制本轮qq.discussion.batchId，不生成编号，也不复用历史工具参数。不得与其他工具并行调用，理由不发给用户。',
        parameters,
      } },
      supervisionLevel: 0,
      executor: { schema: participationSchema, execute: async (input, _shared, ctx) => {
        const view = ctx?.requestView
        if (!view || view.identity.channel !== 'qq' || !view.identity.subject)
          throw new Error('QQ participation requires trusted identity')
        const parsed = participationSchema.parse(input)
        decide(view.requestId, parsed)
        return { content: JSON.stringify({ accepted: true, action: parsed.action }), status: 'ok' }
      } },
    },
    metadata: { label: 'QQ参与判断', description: '内部决定是否继续参与讨论，不直接发送消息', icon: 'qq', doc: 'QQ专用请求级参与决定' },
  }
}
