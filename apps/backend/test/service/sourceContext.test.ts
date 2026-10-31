import { describe, expect, it } from 'vitest'
import { SourceContextRepository, type SourceFreezeInput } from '@/db/sourceContext.js'
import { sourceFixture } from '../helpers/sourceContext.js'

describe('immutable source receipts and frozen selections', () => {
  it('retains identical text as distinct native messages and expands a current quoted record only once', () => {
    const f = sourceFixture()
    try {
      const a = f.receive('相同正文'), b = f.receive('相同正文')
      const current = f.receive([{ type: 'reply', partId: 'p0', platformMessageId: '1' }, { type: 'text', partId: 'p1', text: '继续' }],
        { handling: { kind: 'merged', requestId: 'request' } })
      const snapshot = f.repo.freeze(f.authority, f.scope.scopeId, { requestId: 'request', actorRecord: a.record,
        inputRecords: [a.record, current.record], expectedSelectionRevision: 0,
        policy: { historyLimit: 100, backgroundMaxAgeMs: 100000, backgroundMaxChars: 10000, qqConfigRevision: 1 } })
      const messages = snapshot.orderedItems.filter(item => item.type === 'message')
      expect(messages.map(item => item.recordId)).toEqual([a.record.recordId, b.record.recordId, current.record.recordId])
      expect(messages[0]!.selectionReasons).toEqual(['current', 'explicit_quote'])
      expect(snapshot.quoteRelations[0]!.result).toEqual({ kind: 'resolved', target: a.record })
      expect(f.repo.read(f.authority, f.scope.scopeId, [a.record, b.record]).map(record => record.parts))
        .toEqual([[{ type: 'text', partId: 'p0', text: '相同正文' }], [{ type: 'text', partId: 'p0', text: '相同正文' }]])
    } finally { f.db.close() }
  })

  it('keeps pending receipts observable across recovery and rejects conflicting completion or source content', () => {
    const f = sourceFixture()
    try {
      const input = f.receive('尚未排队', { pending: true }), auth = { ...f.authority, purpose: 'record' as const }
      expect(f.repo.receiptStatus(auth, input.eventId)).toMatchObject({ state: 'pending', record: input.record })
      f.repo.recover(); f.repo.recover()
      expect(f.repo.receiptStatus(auth, input.eventId)).toMatchObject({ state: 'pending', reasonCode: 'interrupted_before_queue' })
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_runs').get()).toEqual({ n: 0 })
      const result = input.complete({ kind: 'queued', requestId: 'request' })
      expect(input.complete({ kind: 'queued', requestId: 'request' })).toEqual(result)
      expect(() => input.complete({ kind: 'queued', requestId: 'different' })).toThrow('SOURCE_CONFLICT')
      const replay = { eventId: input.eventId, messageId: '1', sender: { id: '123', name: '改名\n伪标题' },
        parts: [{ type: 'text' as const, partId: 'p0', text: '尚未排队' }] }
      expect(f.repo.beginReceipt(auth, f.scope.scopeId, replay)).toEqual({ state: 'completed', receiptId: result.receiptId,
        version: result.version, record: result.record, result })
      expect(() => f.repo.beginReceipt(auth, f.scope.scopeId, { ...replay, parts: [{ type: 'text', partId: 'p0', text: '篡改正文' }] }))
        .toThrow('SOURCE_CONFLICT')
      expect(() => f.repo.receiptStatus({ ...auth, actorId: '456' }, input.eventId)).toThrow('PERMISSION_DENIED')
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_records').get()).toEqual({ n: 1 })
    } finally { f.db.close() }
  })

  it('freezes before attachment completion, excludes later arrivals and refuses mixed actors or conflicting reselection', () => {
    const f = sourceFixture()
    try {
      const input = f.receive([{ type: 'attachment', partId: 'p0', attachmentId: 'placeholder' }],
        { handling: { kind: 'queued', requestId: 'request' }, attachments: [{ partId: 'p0', mediaKind: 'file', originalName: 'a.zip' }] })
      const args: SourceFreezeInput = { requestId: 'request', actorRecord: input.record, inputRecords: [input.record], expectedSelectionRevision: 0,
        policy: { historyLimit: 100, backgroundMaxAgeMs: 100000, backgroundMaxChars: 10000, qqConfigRevision: 1 } }
      const snapshot = f.repo.freeze(f.authority, f.scope.scopeId, args), saved = JSON.stringify(snapshot)
      const later = f.receive('另一个人的后续请求', { sender: '456' })
      const recordAuth = { ...f.authority, purpose: 'record' as const }
      const attachment = f.repo.receiptContent(recordAuth, f.scope.scopeId, input.eventId).attachments[0]!
      f.repo.updateAttachment(recordAuth, f.scope.scopeId, attachment.attachmentId, attachment.version,
        { kind: 'unavailable', reasonCode: 'FILE_DOWNLOAD_FAILED' })
      expect(JSON.stringify(f.repo.freeze(f.authority, f.scope.scopeId, args))).toBe(saved)
      expect(JSON.stringify(f.repo.snapshot(f.authority, f.scope.scopeId, snapshot.snapshotId))).toBe(saved)
      expect(snapshot.orderedItems.flatMap(item => item.type === 'message' ? [item.recordId] : [])).toEqual([input.record.recordId])
      expect(() => f.repo.freeze(f.authority, f.scope.scopeId, { ...args, requestId: 'mixed', inputRecords: [input.record, later.record] }))
        .toThrow('IDENTITY_REJECTED')
      expect(() => f.repo.freeze(f.authority, f.scope.scopeId, { ...args, policy: { ...args.policy, historyLimit: 1 } }))
        .toThrow('SOURCE_CONFLICT')
    } finally { f.db.close() }
  })

  it('counts 41 omitted records after one of 42 is restored by quote and never assigns a number to unknown reception', () => {
    const f = sourceFixture()
    try {
      const old = Array.from({ length: 42 }, (_, i) => f.receive(`旧消息${i}`, { sentAt: i + 1 }))
      f.db.prepare('INSERT INTO source_completeness VALUES (?,?,?,?,?)')
        .run('unknown-window', f.scope.scopeId, 'reception_unconfirmed', 1, '{}')
      const current = f.receive([{ type: 'reply', partId: 'p0', platformMessageId: '21' }, { type: 'text', partId: 'p1', text: '引用旧消息' }],
        { sentAt: 43, handling: { kind: 'queued', requestId: 'request' } })
      const snapshot = f.repo.freeze(f.authority, f.scope.scopeId, { requestId: 'request', actorRecord: current.record, inputRecords: [current.record],
        expectedSelectionRevision: 0, policy: { historyLimit: 1, backgroundMaxAgeMs: 0, backgroundMaxChars: 0, qqConfigRevision: 1 } })
      const gaps = snapshot.orderedItems.filter(item => item.type === 'gap' && item.reason === 'omitted_from_context')
      expect(gaps.map(item => item.knownMessageCount)).toEqual([20, 21])
      const omitted = gaps.flatMap(item => JSON.parse((f.db.prepare('SELECT refs_json FROM source_omitted_sets WHERE set_id=?')
        .get(item.omittedSetId) as { refs_json: string }).refs_json) as Array<{ recordId: string }>)
      expect(new Set(omitted.map(record => record.recordId)).size).toBe(41)
      expect(omitted).not.toContainEqual(old[20]!.record)
      expect(snapshot.orderedItems.find(item => item.type === 'gap' && item.reason === 'reception_unconfirmed'))
        .toEqual({ type: 'gap', reason: 'reception_unconfirmed', completenessRecordId: 'unknown-window' })
    } finally { f.db.close() }
  })

  it('uses stable time ordering but ages background by receipt time, not a future platform timestamp', () => {
    const f = sourceFixture()
    try {
      const future = f.receive('将来的平台时间', { sentAt: 999999999 }), first = f.receive('同秒第一条', { sentAt: 100 }),
        second = f.receive('同秒第二条', { sentAt: 100 }), reverse = f.receive('反向到达', { sentAt: 99 })
      const current = f.receive('当前输入', { sentAt: 101, handling: { kind: 'queued', requestId: 'ordered' } })
      const args: SourceFreezeInput = { requestId: 'ordered', actorRecord: current.record, inputRecords: [current.record], expectedSelectionRevision: 0,
        policy: { historyLimit: 100, backgroundMaxAgeMs: 1000000, backgroundMaxChars: 10000, qqConfigRevision: 1 } }
      const ordered = f.repo.freeze(f.authority, f.scope.scopeId, args)
      expect(ordered.ordering).toBe('time_approximate')
      expect(ordered.orderedItems.flatMap(item => item.type === 'message' ? [item.recordId] : []))
        .toEqual([reverse.record.recordId, first.record.recordId, second.record.recordId, current.record.recordId, future.record.recordId])
      const later = new SourceContextRepository(f.db, () => 2000000)
      const aged = later.freeze(f.authority, f.scope.scopeId, { ...args, requestId: 'aged', policy: { ...args.policy, backgroundMaxAgeMs: 1000 } })
      expect(aged.orderedItems.flatMap(item => item.type === 'message' ? [item.recordId] : [])).toEqual([current.record.recordId])
    } finally { f.db.close() }
  })
})
