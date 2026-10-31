import { describe, expect, it, vi } from 'vitest'
import { createReplyTools, replyActionSchema } from '../src/replyTools.js'

describe('QQ native reply tools', () => {
  it('rejects all-member mentions and malformed actions', () => {
    expect(() => replyActionSchema.parse({ kind: 'mention', userId: 'all', text: 'hi', completeReply: true })).toThrow()
    expect(() => replyActionSchema.parse({ kind: 'voice', text: '', character: 'id', completeReply: true })).toThrow()
  })
  it('requires trusted group identity and passes completion as structured data', async () => {
    const bridge = { lookup: vi.fn(async () => ({ items: [] })), reply: vi.fn(async () => ({ status: 'queued' })) }
    const tools = createReplyTools(bridge)
    const voice = tools.find(t => t.sense.definition.function.name === 'qq_interact')!.sense.executor
    const input = { action:'voice', text: '你好', completeReply: true }
    await expect(voice.execute(input, {} as any, {} as any)).rejects.toThrow('trusted group')
    await voice.execute(input, {} as any, { requestView: { requestId: 'r', identity: { channel: 'qq', subject: { conversationType: 'group' } } } } as any)
    expect(bridge.reply).toHaveBeenCalledWith('r', { text:'你好',completeReply:true, kind: 'voice' })
    expect(tools.map(t => t.sense.definition.function.name)).toEqual(['qq_deliver_media','qq_interact'])
  })
  it.each([
    ['quote', 500, { messageId: '10' }],
    ['mention', 500, { userIds: ['20'] }],
    ['voice', 200, {}],
  ] as const)('publishes and enforces the same existing text bound for %s', async (name, limit, fields) => {
    const bridge = { lookup: vi.fn(async () => ({ items: [] })), reply: vi.fn(async () => ({ status: 'queued' })) }
    const tool = createReplyTools(bridge).find(t => t.sense.definition.function.name === 'qq_interact')!
    const definition = tool.sense.definition.function
    const branch=(definition.parameters as any).oneOf.find((branch:any)=>branch.properties.action.const===name)
    expect(branch.properties.text).toEqual({ type: 'string', minLength: 1, maxLength: limit })
    const input = { action:name,...fields, text: '字'.repeat(limit), completeReply: true }
    expect(tool.sense.executor.schema.safeParse(input).success).toBe(true)
    for (const text of ['', '字'.repeat(limit + 1)]) {
      const invalid = { ...input, text }
      expect(tool.sense.executor.schema.safeParse(invalid).success).toBe(false)
      await expect(tool.sense.executor.execute(invalid, {} as any, { requestView: { requestId: 'r',
        identity: { channel: 'qq', subject: { conversationType: 'group' } } } } as any)).rejects.toThrow()
    }
    expect(bridge.reply).not.toHaveBeenCalled()
  })
})
