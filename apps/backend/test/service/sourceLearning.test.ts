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
})
