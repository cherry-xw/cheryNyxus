import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'

type Registration = Parameters<IngressContext['tools']['register']>[0]
export const replyActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quote'), userId: z.string().regex(/^[1-9]\d{0,19}$/).optional(), messageId: z.string().regex(/^-?\d+$/), text: z.string().min(1).max(500), completeReply: z.boolean() }).strict(),
  z.object({ kind: z.literal('mention'), userId: z.string().regex(/^[1-9]\d{0,19}$/), text: z.string().min(1).max(500), completeReply: z.boolean() }).strict(),
  z.object({ kind: z.literal('reaction'), emojiId: z.string().regex(/^\d+$/), completeReply: z.boolean() }).strict(),
  z.object({ kind: z.literal('poke'), userId: z.string().regex(/^[1-9]\d{0,19}$/), completeReply: z.boolean() }).strict(),
  z.object({ kind: z.literal('voice'), text: z.string().min(1).max(200), character: z.string().min(1).max(100), completeReply: z.boolean() }).strict(),
])
export type ReplyAction = z.infer<typeof replyActionSchema>
export interface QQReplyBridge {
  lookup(requestId: string, kind: 'members' | 'voices', query: string): Promise<unknown>
  reply(requestId: string, action: ReplyAction): Promise<unknown>
}

/** Transport and target authorization remain owned by the QQ runtime. */
export function createReplyTools(bridge: QQReplyBridge): Registration[] {
  const lookup = z.object({ kind: z.enum(['members', 'voices']), query: z.string().max(100) }).strict()
  const tools: Array<{ name: string; description: string; schema: z.ZodType; parameters: Registration['sense']['definition']['function']['parameters']; run: (requestId: string, input: any) => Promise<unknown> }> = [
    { name: 'qq_lookup', description: 'QQ群专用：按需查询当前群成员或真实语音角色。重名须确认，不猜QQ号和声音ID。', schema: lookup,
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['members', 'voices'] }, query: { type: 'string' } }, required: ['kind', 'query'], additionalProperties: false },
      run: (id, input) => bridge.lookup(id, input.kind, input.query) },
  ]
  const actions = [
    { kind: 'quote', name: 'qq_quote_reply', description: '引用当前群背景中的真实消息并回复，不猜消息ID，不跨群引用。', properties: { messageId: { type: 'string' }, text: { type: 'string' }, userId: { type: 'string' } } },
    { kind: 'mention', name: 'qq_mention', description: '原生@当前群已核实成员并发送文字，不支持@全体。', properties: { userId: { type: 'string' }, text: { type: 'string' } } },
    { kind: 'reaction', name: 'qq_react', description: '用已核实的QQ表情回应本轮消息；可作为完整回复，不另发文字。', properties: { emojiId: { type: 'string' } } },
    { kind: 'poke', name: 'qq_poke', description: '戳当前群已核实成员一次；不能随机选人或连续骚扰。', properties: { userId: { type: 'string' } } },
    { kind: 'voice', name: 'qq_voice_reply', description: '用真实可用声音发送简短语音回复。链接和代码优先文字。', properties: { text: { type: 'string' }, character: { type: 'string' } } },
  ] as const
  for (const action of actions) {
    const shape = replyActionSchema.options.find(s => s.shape.kind.value === action.kind)!
    const schema = z.object(Object.fromEntries(Object.entries(shape.shape).filter(([key]) => key !== 'kind')) as Record<string, z.ZodType>).strict()
    tools.push({ name: action.name, description: action.description + ' completeReply=true表示这就是本轮完整回复；排队不等于已发送。', schema,
      parameters: { type: 'object', properties: { ...action.properties, completeReply: { type: 'boolean' } }, required: [...Object.keys(action.properties).filter(k => action.kind !== 'quote' || k !== 'userId'), 'completeReply'], additionalProperties: false },
      run: (id, input) => bridge.reply(id, replyActionSchema.parse({ ...input, kind: action.kind })) })
  }
  return tools.map(tool => ({
    sense: { definition: { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }, supervisionLevel: 0,
      executor: { schema: tool.schema, execute: async (input, _shared, ctx) => {
        const view = ctx?.requestView
        if (!view || view.identity.channel !== 'qq' || view.identity.subject?.conversationType !== 'group') throw new Error('QQ reply requires a trusted group request')
        const result = await tool.run(view.requestId, tool.schema.parse(input))
        return { content: JSON.stringify(result), status: 'ok' }
      } } },
    metadata: { label: tool.name, description: tool.description, icon: 'qq', doc: 'QQ可信当前群回复能力' },
  }))
}
