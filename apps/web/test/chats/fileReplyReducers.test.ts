import { describe, expect, it } from 'vitest'
import type { MessagePart } from '@chery/protocol'
import { createEmptySession } from '../../src/stores/chats/model/hydration'
import { reduceConsumed, reduceRoleReply } from '../../src/stores/chats/model/reducer'

const parts: MessagePart[] = [
  { type: 'text', partId: 'before', text: '前文' },
  { type: 'asset', partId: 'file', assetId: 'asset', assetVersionId: 'version', usage: 'reference-only', variant: 'original' },
  { type: 'text', partId: 'after', text: '后文' },
]

describe('接收与角色回传中的有序文件', () => {
  it('接收确认补齐已有文字消息的文件，重复确认不重复消息', () => {
    const session = createEmptySession('parent')
    const input = { id: 'input', role: 'user' as const, content: '前文后文', createdAt: 1, updateAt: 2 }
    reduceConsumed(session, [input])
    reduceConsumed(session, [{ ...input, parts }])
    reduceConsumed(session, [{ ...input, parts }])
    expect(session.messageOrder).toEqual(['input'])
    expect(session.messagesById.input?.parts).toEqual(parts)
    expect(session.messagesById.input?.parts?.[1]).not.toBe(parts[1])
  })

  it('角色通知保留摘要文件与来源，并可补齐先到的文字消息', () => {
    const session = createEmptySession('parent')
    const reply = { msgId: 'reply', childChatId: 'child', type: 'worker', content: '任务未完整成功', spawnSenseCallId: 'spawn' }
    reduceRoleReply(session, reply, { now: 1 })
    reduceRoleReply(session, { ...reply, summaryParts: parts }, { now: 2 })
    expect(session.messageOrder).toEqual(['reply'])
    expect(session.messagesById.reply).toMatchObject({ role: 'role', content: reply.content, parts, agentChatId: 'child', spawnSenseCallId: 'spawn' })
  })
})
