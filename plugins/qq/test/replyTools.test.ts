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
    const voice = tools.find(t => t.sense.definition.function.name === 'qq_voice_reply')!.sense.executor
    const input = { text: '你好', completeReply: true }
    await expect(voice.execute(input, {} as any, {} as any)).rejects.toThrow('trusted group')
    await voice.execute(input, {} as any, { requestView: { requestId: 'r', identity: { channel: 'qq', subject: { conversationType: 'group' } } } } as any)
    expect(bridge.reply).toHaveBeenCalledWith('r', { ...input, kind: 'voice' })
    expect(tools.map(t => t.sense.definition.function.name)).toEqual(['qq_lookup', 'qq_quote_reply', 'qq_mention', 'qq_react', 'qq_poke', 'qq_voice_reply'])
  })
})
