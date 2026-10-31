import { describe, expect, it } from 'vitest'
import { sourceFixture } from '../helpers/sourceContext.js'

describe('source scope replacement and offline recovery', () => {
  it('creates fresh A/B/A, reset and reallowed scopes, but never advances a repeated application twice', () => {
    const f = sourceFixture()
    try {
      const original = f.receive('original input')
      const apply = (revision: number, presetId = f.target.presetId, qqContextEpoch = '') =>
        f.repo.applyScopes(f.authority, revision, [{ ...f.target, presetId, qqContextEpoch }])[0]!
      const b = apply(2, 'B'), a = apply(3), reset = apply(4, f.target.presetId, 'reset')
      expect(new Set([f.scope.scopeId, b.scopeId, a.scopeId, reset.scopeId]).size).toBe(4)
      expect([f.scope.generation,b.generation,a.generation,reset.generation]).toEqual([1,2,3,4])
      expect([f.scope.permissionRevision,b.permissionRevision,a.permissionRevision,reset.permissionRevision]).toEqual([1,2,3,4])
      expect(apply(4, f.target.presetId, 'reset')).toEqual(reset)
      expect(()=>f.repo.read(f.authority,f.scope.scopeId,[original.record])).toThrow('PERMISSION_DENIED')
      expect(()=>f.repo.read(f.authority,reset.scopeId,[original.record])).toThrow('PERMISSION_DENIED')
      const replay = f.repo.beginReceipt({...f.authority,purpose:'record'},reset.scopeId,{
        eventId:'1',messageId:'1',sender:{id:'123',name:'123'},parts:[{type:'text',partId:'p0',text:'original input'}] })
      expect(replay.record).toEqual(original.record)
      expect(replay.state).toBe('completed')
      expect(()=>f.repo.read(f.authority,reset.scopeId,[original.record])).toThrow('PERMISSION_DENIED')
      expect(f.repo.applyScopes(f.authority,5,[])).toEqual([])
      expect(()=>f.repo.scope(f.authority,reset.scopeId)).toThrow('PERMISSION_DENIED')
      const reallowed = apply(6)
      expect(reallowed.generation).toBe(5)
      expect(reallowed.permissionRevision).toBe(6)
      expect(reallowed.scopeId).not.toBe(a.scopeId)
    } finally { f.db.close() }
  })

  it('rolls back the whole configuration if authority fails at commit and rejects conflicting revisions', () => {
    const f=sourceFixture()
    try {
      let checks=0
      const owner={...f.authority,validate(){if(++checks===2)throw new Error('synthetic revoked authority')}}
      expect(()=>f.repo.applyScopes(owner,2,[{...f.target,presetId:'B'}])).toThrow('synthetic revoked authority')
      expect(f.repo.scope(f.authority,f.scope.scopeId)).toEqual(f.scope)
      const next=f.repo.applyScopes(f.authority,2,[{...f.target,presetId:'B'}])[0]!
      expect(next.generation).toBe(2)
      expect(()=>f.repo.applyScopes(f.authority,2,[f.target])).toThrow('SOURCE_CONFLICT')
      expect(()=>f.repo.applyScopes(f.authority,0,[f.target])).toThrow('REVISION_CONFLICT')
    } finally {f.db.close()}
  })
})
