import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Adapter } from '../../../../platform/napcat-plugin/src/adapter.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'qq-native-')); roots.push(root)
  const call = vi.fn(async (name: string) => name === 'get_group_member_list' ? [{ user_id: 789, nickname: '鲸鱼', card: '群名片' }] : name === 'get_ai_characters' ? [{ characters: [{ character_id: 'voice-1', character_name: '声音' }] }] : { message_id: 42 })
  const request = vi.fn(async () => ({ success: true }))
  const adapter = new Adapter({ dataPath: root, actions: { call }, logger: {}, pluginManager: { config: {} } } as any, { request } as any)
  ;(adapter as any).selfId = '123'
  return { adapter, call, request }
}
function event(kind: string, extra: object = {}) { return { kind: 'notification', type: 'qq.reply.action', data: { selfId: '123', targetId: '456', conversationType: 'group', requestId: 'r', eventId: kind, seq: 1, actionKind: kind, completeReply: true, text: '你好', ...extra } } }
describe('native QQ adapter actions', () => {
  it('sends native mention and voice, without an extra text response', async () => {
    const f = fixture()
    await (f.adapter as any).notification(event('mention', { userId: '789' }))
    expect(f.call).toHaveBeenCalledWith('send_msg', expect.objectContaining({ message: [{ type: 'at', data: { qq: '789' } }, { type: 'text', data: { text: '你好' } }] }), undefined, {})
    await (f.adapter as any).notification(event('voice', { character: 'voice-1' }))
    expect(f.call).toHaveBeenCalledWith('send_group_ai_record', { group_id: '456', character: 'voice-1', text: '你好' }, undefined, {})
    expect(f.call).toHaveBeenCalledTimes(2)
    expect(f.request).toHaveBeenLastCalledWith('qq.delivery.result', expect.objectContaining({ messageIds: ['42'], terminal: true, status: 'sent' }))
  })
  it('confirms reaction with no new message ID and deduplicates replay', async () => {
    const f = fixture(); f.call.mockResolvedValue({} as any)
    const e = event('reaction', { emojiId: '4', messageId: '-1' })
    await (f.adapter as any).notification(e); await (f.adapter as any).notification(e)
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.call).toHaveBeenCalledWith('set_msg_emoji_like', { message_id: '-1', emoji_id: '4', set: true }, undefined, {})
    expect(f.request).toHaveBeenCalledWith('qq.delivery.result', expect.objectContaining({ messageIds: [], terminal: true, status: 'sent' }))
  })
  it('retries confirmation without repeating successful poke or reporting unknown', async () => {
    const f = fixture(); f.call.mockResolvedValue({} as any)
    f.request.mockRejectedValueOnce(new Error('confirmation disconnected'))
    const e = event('poke', { userId: '789', completeReply: false })
    await (f.adapter as any).notification(e)
    await (f.adapter as any).notification(e)
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.request).toHaveBeenCalledTimes(3)
    expect(f.request.mock.calls.every(c => (c as unknown as any[])[1].status === 'sent')).toBe(true)
  })
  it('sends native quote with optional mention', async () => {
    const f = fixture()
    await (f.adapter as any).notification(event('quote', { messageId: '-7', userId: '789' }))
    expect(f.call).toHaveBeenCalledWith('send_msg', expect.objectContaining({ message: [{ type: 'reply', data: { id: '-7' } }, { type: 'at', data: { qq: '789' } }, { type: 'text', data: { text: '你好' } }] }), undefined, {})
  })
  it('distinguishes explicit rejection from uncertain delivery', async () => {
    const f = fixture(); f.call.mockResolvedValue({ retcode: 1400 } as any)
    await (f.adapter as any).notification(event('voice', { character: 'voice-1' }))
    expect(f.request).toHaveBeenCalledWith('qq.delivery.result', expect.objectContaining({ status: 'failed', terminal: true }))
  })
  it('returns real member and voice directory projections', async () => {
    const f = fixture()
    for (const lookupKind of ['members', 'voices']) await (f.adapter as any).notification({ kind: 'notification', type: 'qq.lookup.request', data: { selfId: '123', targetId: '456', conversationType: 'group', lookupKind, lookupId: lookupKind } })
    expect(f.request).toHaveBeenCalledWith('qq.lookup.result', expect.objectContaining({ kind: 'members', success: true, items: [{ id: '789', name: '鲸鱼', card: '群名片' }] }))
    expect(f.request).toHaveBeenCalledWith('qq.lookup.result', expect.objectContaining({ kind: 'voices', success: true, items: [{ id: 'voice-1', name: '声音' }] }))
  })
})
