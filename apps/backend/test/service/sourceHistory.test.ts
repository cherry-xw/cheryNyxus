import { describe, expect, it } from 'vitest'
import { readSourceHistory, readSourceText } from '@/db/sourceHistory.js'
import type { SourceHistoryRecord, SourceTextRef } from '@chery/protocol'
import { sourceFixture } from '../helpers/sourceContext.js'

function text(record: SourceHistoryRecord): SourceTextRef {
  const part = record.parts.find(part => part.type === 'text')
  if (part?.type !== 'text') throw new Error('Missing fixture text')
  return part.body
}

describe('retained source history and fixed text continuation', () => {
  it.each(['group', 'private'] as const)('pages %s source history with a fixed reception bound and approximate time ordering', type => {
    const f = sourceFixture(type)
    try {
      const first = f.receive('one', {sentAt:100}), second = f.receive('two', {sentAt:200}), third = f.receive('three', {sentAt:200})
      const input = f.start()
      const page = readSourceHistory(f.repo, f.authority, {...input,count:2})
      expect(page.records.map(row => row.source.recordId)).toEqual([third.record.recordId, input.snapshot.actorRecord!.recordId])
      expect(page.ordering).toBe('time_approximate')
      expect(page.completeness).toEqual([{kind:'history_start',observedAt:f.scope.createdAt}])
      expect(page.nextCursor).toBeTruthy()
      const late = f.receive('late old timestamp', {sentAt:0})
      const older = readSourceHistory(f.repo, f.authority, {...input,cursor:page.nextCursor!})
      expect(older.throughIngestOrdinal).toBe(page.throughIngestOrdinal)
      expect(older.records.map(row => row.source.recordId)).toEqual([first.record.recordId,second.record.recordId])
      expect(older.nextCursor).toBeNull()
      expect(readSourceHistory(f.repo, f.authority, {...input,count:100}).records.some(row => row.source.recordId === late.record.recordId)).toBe(true)
      expect(()=>readSourceHistory(f.repo,f.authority,{...input,count:3,cursor:page.nextCursor!})).toThrow('INVALID_PARAMS')
    } finally { f.db.close() }
  })
  it('joins Unicode text without missing or repeating preview characters, and can reread from zero', () => {
    const f = sourceFixture()
    try {
      const original = '中😀é\n'.repeat(7000), source = f.receive(original), input = f.start()
      const page = readSourceHistory(f.repo,f.authority,{...input,count:100})
      const reference = text(page.records.find(record => record.source.recordId === source.record.recordId)!)
      expect(reference.previewCodePoints).toBe(1024)
      expect(reference.totalCodePoints).toBe(Array.from(original).length)
      let restored = reference.preview, cursor = reference.nextCursor, position = reference.previewCodePoints
      while (cursor) {
        const next = readSourceText(f.repo,f.authority,{...input,textRefId:reference.textRefId,cursor})
        expect(next.startCodePoint).toBe(position)
        expect(next.endCodePoint-next.startCodePoint).toBeLessThanOrEqual(8192)
        restored += next.text; position = next.endCodePoint; cursor = next.nextCursor
      }
      expect(restored).toBe(original)
      expect(readSourceText(f.repo,f.authority,{...input,textRefId:reference.textRefId}).text).toBe(Array.from(original).slice(0,8192).join(''))
      expect(text(readSourceHistory(f.repo,f.authority,input).records.find(record=>record.source.recordId===source.record.recordId)!).textRefId).toBe(reference.textRefId)
    } finally { f.db.close() }
  })
  it('does not disclose text through another member, run, target, arbitrary ID or mismatched text cursor', () => {
    const f = sourceFixture()
    try {
      f.receive('甲'.repeat(10000)); f.receive('乙'.repeat(10000))
      const input=f.start(),page=readSourceHistory(f.repo,f.authority,{...input,count:2}),reference=text(page.records[0]!)
      const otherText=text(readSourceHistory(f.repo,f.authority,{...input,count:100}).records[0]!)
      const next=f.start('next-request','next-run')
      for (const auth of [{...f.authority,actorId:'456'}, {...f.authority,targetId:'888'}, {...f.authority,purpose:'management' as const}])
        expect(()=>readSourceHistory(f.repo,auth,input)).toThrow('PERMISSION_DENIED')
      expect(()=>readSourceHistory(f.repo,f.authority,{...next,cursor:page.nextCursor!})).toThrow('CURSOR_EXPIRED')
      expect(()=>readSourceText(f.repo,f.authority,{...next,textRefId:reference.textRefId})).toThrow('PERMISSION_DENIED')
      expect(()=>readSourceText(f.repo,f.authority,{...input,textRefId:reference.textRefId,cursor:otherText.nextCursor!})).toThrow('INVALID_PARAMS')
      expect(()=>readSourceText(f.repo,f.authority,{...input,textRefId:'invented'})).toThrow('PERMISSION_DENIED')
      expect(()=>readSourceHistory(f.repo,f.authority,{...input,cursor:'invented'})).toThrow('CURSOR_EXPIRED')
    } finally { f.db.close() }
  })
  it('rejects pending input and different runtime identities when binding a source run', () => {
    const f=sourceFixture()
    try {
      const receipt=f.receive('not completed',{pending:true})
      expect(()=>f.start('request','run',receipt.record)).toThrow('PERMISSION_DENIED')
      receipt.complete({kind:'queued',requestId:'request'})
      f.start('request','run',receipt.record)
      expect(()=>f.repo.ensureRun({...f.authority,actorId:'456'},f.scope.scopeId,'request','run')).toThrow('PERMISSION_DENIED')
      expect(()=>f.repo.ensureRun(f.authority,f.scope.scopeId,'request','other-run')).toThrow('PERMISSION_DENIED')
    } finally { f.db.close() }
  })
  it('keeps every page below the JSON limit and returns a progressing cursor for large individual records', () => {
    const f=sourceFixture()
    try {
      f.receive(Array.from({length:100},(_,i)=>({type:'text' as const,partId:`p${i}`,text:'中'.repeat(1000)})))
      const input=f.start(),page=readSourceHistory(f.repo,f.authority,{...input,count:100})
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256*1024)
      expect(page.records).not.toHaveLength(0)
      const large=page.records.find(record=>record.parts.length===100)
      if (large) expect(text(large).previewCodePoints).toBeLessThan(1000)
      else {
        const next=readSourceHistory(f.repo,f.authority,{...input,cursor:page.nextCursor!})
        expect(next.records[0]!.parts).toHaveLength(100)
        expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(256*1024)
        expect(text(next.records[0]!).nextCursor).toBeTruthy()
        expect(next.nextCursor).toBeNull()
      }
    } finally { f.db.close() }
  })
  it('rechecks scope permission before text return and invalidates old cursors when the preset changes', () => {
    const f=sourceFixture()
    try {
      f.receive('secret'.repeat(1000))
      const input=f.start(),page=readSourceHistory(f.repo,f.authority,input),reference=text(page.records[0]!)
      f.repo.applyScopes(f.authority,2,[{...f.target,presetId:'another-preset'}])
      expect(()=>readSourceHistory(f.repo,f.authority,{...input,cursor:page.nextCursor??undefined})).toThrow('PERMISSION_DENIED')
      expect(()=>readSourceText(f.repo,f.authority,{...input,textRefId:reference.textRefId})).toThrow('PERMISSION_DENIED')
    } finally { f.db.close() }
  })
  it('does not return saved text after the live host authority is revoked', () => {
    const f=sourceFixture()
    try {
      const input=f.start(),page=readSourceHistory(f.repo,f.authority,input),reference=text(page.records[0]!)
      f.revoke()
      expect(()=>readSourceText(f.repo,f.authority,{...input,textRefId:reference.textRefId})).toThrow('PERMISSION_DENIED')
    } finally { f.db.close() }
  })
})
