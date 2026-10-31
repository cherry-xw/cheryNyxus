import { describe, expect, it } from 'vitest'
import { sourceFixture } from '../helpers/sourceContext.js'

describe('observation derived reply authority', () => {
  function observe() {
    const f = sourceFixture()
    const trigger = f.receive('看看讨论', { handling: { kind: 'queued', requestId: 'observe' } })
    const anchor = f.receive('实际回应乙', { sender: '456' })
    const args = { requestId: 'observe', actorRecord: trigger.record, inputRecords: [trigger.record], observationCandidates: [trigger.record, anchor.record],
      expectedSelectionRevision: 0, policy: { historyLimit: 100, backgroundMaxAgeMs: 100000, backgroundMaxChars: 100000, qqConfigRevision: 1 } }
    f.repo.freeze(f.authority, f.scope.scopeId, args)
    f.repo.ensureRun(f.authority, f.scope.scopeId, 'observe', 'observe-run')
    const call = { id: 'decision', name: 'qq_participation_decide', arguments: JSON.stringify({ action: 'reply', batchId: 'observe', anchorRecord: anchor.record, reason: '可回应' }) }
    f.repo.saveRunMessage(f.authority, f.scope.scopeId, 'observe-run', { id: 'assistant', role: 'assistant', content: '', senseCalls: [call], createdAt: 1, updateAt: 1 }, 'completed')
    const complete = () => f.repo.saveRunMessage(f.authority, f.scope.scopeId, 'observe-run', { id: 'decision', role: 'sense', content: '{"accepted":true,"action":"reply"}', createdAt: 2, updateAt: 2 }, 'completed')
    return { f, trigger, anchor, args, complete }
  }
  it('requires successful tool evidence, keeps original receipt and authorizes only the selected actor', () => {
    const { f, anchor, args, complete } = observe()
    try {
      expect(() => f.repo.deriveReply(f.authority, f.scope.scopeId, 'observe', anchor.record)).toThrow()
      complete()
      const reply = f.repo.deriveReply(f.authority, f.scope.scopeId, 'observe', anchor.record)
      expect(f.repo.deriveReply(f.authority, f.scope.scopeId, 'observe', anchor.record)).toEqual(reply)
      expect(f.repo.receiptStatus({ ...f.authority, actorId: '456', purpose: 'record' }, anchor.eventId)).toMatchObject({ result: { handling: { kind: 'background' } } })
      const authority = { ...f.authority, actorId: '456' }
      f.repo.freeze(authority, f.scope.scopeId, { ...args, requestId: reply.requestId, actorRecord: anchor.record, inputRecords: [anchor.record], observationCandidates: undefined })
      expect(f.repo.ensureRun(authority, f.scope.scopeId, reply.requestId, 'reply-run')).toBe('reply-run')
      expect(() => f.repo.ensureRun(f.authority, f.scope.scopeId, reply.requestId, 'other-run')).toThrow('PERMISSION_DENIED')
      f.revoke()
      expect(() => f.repo.deriveReply(f.authority, f.scope.scopeId, 'observe', anchor.record)).toThrow('PERMISSION_DENIED')
    } finally { f.db.close() }
  })
  it('does not turn an ordinary frozen input into an observation or select a later message', () => {
    const { f, anchor, complete } = observe()
    try {
      complete()
      const late = f.receive('后来加入的消息', { sender: '456' })
      expect(() => f.repo.deriveReply(f.authority, f.scope.scopeId, 'observe', late.record)).toThrow('PERMISSION_DENIED')
      f.db.prepare('DELETE FROM source_observation_batches').run()
      expect(() => f.repo.deriveReply(f.authority, f.scope.scopeId, 'observe', anchor.record)).toThrow('PERMISSION_DENIED')
    } finally { f.db.close() }
  })
})
