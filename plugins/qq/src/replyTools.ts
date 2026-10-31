import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'
import { SourceRecordRefSchema } from '@chery/protocol'
import { withOperations } from './operationPolicy.js'

type Registration = Parameters<IngressContext['tools']['register']>[0]
const replyTextLimit = 500
const voiceTextLimit = 200
export const replyActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quote'), userId: z.string().regex(/^[1-9]\d{0,19}$/).optional(), messageId: z.string().regex(/^-?\d+$/), text: z.string().min(1).max(replyTextLimit), completeReply: z.boolean() }).strict(),
  z.object({ kind: z.literal('mention'), userId: z.string().regex(/^[1-9]\d{0,19}$/), text: z.string().min(1).max(replyTextLimit), completeReply: z.boolean() }).strict(),
  z.object({ kind: z.literal('reaction'), messageId: z.string().regex(/^-?\d+$/), emojiId: z.string().regex(/^\d+$/), completeReply: z.boolean() }).strict(),
  z.object({ kind: z.literal('poke'), userId: z.string().regex(/^[1-9]\d{0,19}$/), completeReply: z.boolean() }).strict(),
  z.object({ kind: z.literal('voice'), text: z.string().min(1).max(voiceTextLimit), requestSource: SourceRecordRefSchema.optional(), completeReply: z.boolean() }).strict(),
])
export type ReplyAction = z.infer<typeof replyActionSchema>
export interface QQReplyBridge {
  lookup(requestId: string, kind: 'members' | 'voices', query: string): Promise<unknown>
  reply(requestId: string, action: ReplyAction): Promise<unknown>
  deliverMedia?(requestId: string, input: { mediaFile: string; fileName?: string; forceUploadAsFile?: boolean }): Promise<unknown>
}

/** Transport and target authorization remain owned by the QQ runtime. */
export function createReplyTools(bridge: QQReplyBridge): Registration[] {
  const deliverSchema = z.object({
    mediaFile: z.string().regex(/^\d+\.mp4$/).max(64),
    fileName: z.string().min(1).max(180).optional(),
    forceUploadAsFile: z.boolean().optional(),
  }).strict()
  const tools: Array<{ name: string; allowPrivate?: boolean; description: string; schema: z.ZodType; parameters: Registration['sense']['definition']['function']['parameters']; run: (requestId: string, input: any) => Promise<unknown> }> = [
    { name: 'qq_deliver_media', allowPrivate: true, description: '向当前QQ群或私聊投递已下载到共享media目录(/workspace/media)的兼容MP4视频文件(文件名形如1792200000.mp4)。体积超过气泡上限时会自动转为群文件/私聊文件上传。', schema: deliverSchema,
      parameters: { type: 'object', properties: { mediaFile: { type: 'string' }, fileName: { type: 'string' }, forceUploadAsFile: { type: 'boolean' } }, required: ['mediaFile'], additionalProperties: false },
      run: (id, input) => {
        if (!bridge.deliverMedia) throw new Error('Media delivery not configured')
        return bridge.deliverMedia(id, input)
      } },
  ]
  const interact = z.discriminatedUnion('action', replyActionSchema.options.map(option => {
    const { kind, ...shape } = option.shape
    if (kind.value === 'mention') { const { userId, ...rest } = shape as any; return z.object({ ...rest, action: kind, userIds: z.array(z.string().regex(/^[1-9]\d{0,19}$/)).min(1).max(10).refine(ids => new Set(ids).size === ids.length) }).strict() }
    return z.object({ ...shape, action: kind }).strict()
  }) as any)
  tools.push({ name: 'qq_interact', description: '当前群原生互动。action=quote/mention/reaction/poke/voice。引用与表情必须给真实messageId；mention/poke先查真实userId。语音使用固定声音，每请求最多一条；requested模式须requestSource引用本次真实语音要求。completeReply必须显式提供，true承担完整回复，不重复文字。排队不表示送达。', schema: interact,
    parameters: z.toJSONSchema(interact) as any, run: async (id, input) => {
      const { action, ...rest } = input
      if (action === 'mention') {
        const { userIds, ...args } = rest
        const results = []
        for (const [index, userId] of userIds.entries()) results.push(await bridge.reply(id, replyActionSchema.parse({ ...args, kind: action, userId, text: index === userIds.length - 1 ? args.text : ' ', completeReply: index === userIds.length - 1 && args.completeReply })))
        return { results }
      }
      return bridge.reply(id, replyActionSchema.parse({ ...rest, kind: action }))
    } })
  return tools.map(tool => {
    const registration: Registration = {
    sense: { definition: { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }, supervisionLevel: 0,
      executor: { schema: tool.schema, execute: async (input, _shared, ctx) => {
        const view = ctx?.requestView
        if (!view || view.identity.channel !== 'qq' || (!tool.allowPrivate && view.identity.subject?.conversationType !== 'group')) throw new Error('QQ reply requires a trusted group request')
        const result = await tool.run(view.requestId, tool.schema.parse(input))
        return { content: JSON.stringify(result), status: 'ok' }
      } } },
    metadata: { label: tool.name, description: tool.description, icon: 'qq', doc: 'QQ可信当前群回复能力' },
    }
    return tool.name === 'qq_interact' ? withOperations(registration, 'action', ['quote','mention','reaction','poke','voice']) : registration
  })
}
