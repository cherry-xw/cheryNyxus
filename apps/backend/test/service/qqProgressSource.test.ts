import { describe, expect, it } from 'vitest'
import { sourceFixture } from '../helpers/sourceContext.js'

describe('QQ periodic reaction source records', () => {
  it('records periodic reactions as progress without changing ordinary reactions', () => {
    const f = sourceFixture()
    try {
      const data = { requestId: 'request', selfId: '100', conversationType: 'group' as const, targetId: '999',
        seq: 1, actionKind: 'reaction' as const, messageId: '1', emojiId: '178', completeReply: false }
      f.repo.recordDelivery(f.authority, f.scope.scopeId, { kind: 'notification', type: 'qq.reply.action', data: { ...data, eventId: 'progress', state: 'progress' } })
      f.repo.recordDelivery(f.authority, f.scope.scopeId, { kind: 'notification', type: 'qq.reply.action', data: { ...data, eventId: 'ordinary', seq: 2 } })
      expect(f.db.prepare('SELECT delivery_id,purpose,kind FROM source_deliveries ORDER BY delivery_id').all()).toEqual([
        { delivery_id: 'ordinary', purpose: 'reply', kind: 'action' },
        { delivery_id: 'progress', purpose: 'progress', kind: 'action' },
      ])
    } finally { f.db.close() }
  })
})
