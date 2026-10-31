import { describe, expect, it } from 'vitest'
import { sourceFixture } from '../helpers/sourceContext.js'

describe('independent source learning', () => {
  it('fixes sources independently of summary advancement and rejects revoked access', () => {
    const f = sourceFixture()
    try {
      f.receive('本群约定使用该术语')
      const auth = f.repo.maintenanceAuthority(f.authority, f.scope.scopeId)
      const input = { operationId: 'learn-one', qqConfigRevision: 1, afterOrdinal: 0, afterRun: 0, completedRequests: [] }
      const first = f.repo.prepareLearning(auth, f.scope.scopeId, input)!
      expect(first.records).toHaveLength(1)
      f.receive('之后加入的资料')
      expect(f.repo.prepareLearning(auth, f.scope.scopeId, input)!.records).toEqual(first.records)
      expect(f.repo.learningStatus(auth, f.scope.scopeId, input.operationId).snapshotId).toBe(first.operation.snapshotId)
      expect(f.repo.updateLearning(auth, f.scope.scopeId, { operationId: input.operationId, expectedVersion: 1, status: 'running' }).version).toBe(2)
      expect(() => f.repo.updateLearning(auth, f.scope.scopeId, { operationId: input.operationId, expectedVersion: 1, status: 'completed' })).toThrow()
      f.revoke()
      expect(() => f.repo.learningStatus(auth, f.scope.scopeId, input.operationId)).toThrow('PERMISSION_DENIED')
    } finally { f.db.close() }
  })
  it('includes actual execution and web observations under same-scope maintenance authority',()=>{
    const f=sourceFixture()
    try {
      const run=f.start()
      f.repo.saveRunMessage(f.authority,f.scope.scopeId,run.runId,{id:'reply',role:'assistant',content:'已经排队，不代表已发送'} as any,'completed')
      const observation={ok:true,url:'https://example.com/term',observedAt:'2026-10-29T00:00:00Z',text:'已读的公开释义',publicEligible:true,truncated:false}
      f.repo.saveToolObservation(f.authority,f.scope.scopeId,run.runId,'web-call','web_fetch',{content:'not evidence',status:'ok',observation:{kind:'observation',content:JSON.stringify(observation)} as any})
      const auth=f.repo.maintenanceAuthority(f.authority,f.scope.scopeId)
      const prepared=f.repo.prepareLearning(auth,f.scope.scopeId,{operationId:'learn-run',qqConfigRevision:1,afterOrdinal:0,afterRun:0,completedRequests:[run.requestId]})!
      expect(prepared.runs[0]!.messages[0]!.body.content).toContain('不代表已发送')
      expect(prepared.evidence).toHaveLength(1);expect(prepared.evidence[0]).toMatchObject({text:observation.text,publicEligible:true})
      f.db.prepare('DELETE FROM source_tool_observations WHERE call_id=?').run('web-call')
      expect(()=>f.repo.learningStatus(auth,f.scope.scopeId,'learn-run')).toThrow('SOURCE_NOT_FOUND')
    }finally{f.db.close()}
  })
  it('advances past disabled records without adding them to fixed learning input',()=>{
    const f=sourceFixture()
    try {
      f.receive('关闭期间的文字')
      const auth=f.repo.maintenanceAuthority(f.authority,f.scope.scopeId)
      const prepared=f.repo.prepareLearning(auth,f.scope.scopeId,{operationId:'skip-disabled',qqConfigRevision:1,afterOrdinal:0,afterRun:0,completedRequests:[],since:20000})!
      expect(prepared.records).toEqual([]);expect(prepared.throughOrdinal).toBeGreaterThan(0)
      expect(f.repo.prepareLearning(auth,f.scope.scopeId,{operationId:'next',qqConfigRevision:1,afterOrdinal:prepared.throughOrdinal,afterRun:0,completedRequests:[],since:20000})).toBeNull()
    }finally{f.db.close()}
  })
})
