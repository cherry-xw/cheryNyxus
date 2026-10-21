import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { BackendResumeRepository, initBackendResumeTables } from '@/db/backendResume.js'

describe('BackendResumeRepository', () => {
  it('restores the state before stop on cancel, but never clears an earlier restart gate', () => {
    const db = new Database(':memory:')
    try {
      db.exec("CREATE TABLE chats (id TEXT PRIMARY KEY); INSERT INTO chats VALUES ('queued'), ('old'), ('running')")
      initBackendResumeTables(db)
      const resume = new BackendResumeRepository(db)
      resume.recover(['old'])
      resume.park(['old', 'queued', 'running'], 'stop-one')
      resume.park(['old', 'queued'], 'stop-one')
      expect(resume.required('queued')).toBe(true)
      expect(resume.continuationRequired('running', 'stop-one')).toBe(false)
      expect(resume.continuationRequired('old', 'stop-one')).toBe(true)
      expect(resume.continuationRequired('running', 'stale')).toBe(true)
      expect(resume.cancel('stale')).toEqual([])
      resume.cancel('stop-one')
      expect(resume.required('queued')).toBe(false)
      expect(resume.required('running')).toBe(false)
      expect(resume.required('old')).toBe(true)
      resume.resume('old')
      expect(resume.required('old')).toBe(false)
      resume.park(['queued'], 'stop-two')
      // A new process recovers persisted state without restoring former stop permissions.
      const restarted = new BackendResumeRepository(db)
      restarted.recover(['queued'])
      restarted.cancel('stop-two')
      expect(restarted.required('queued')).toBe(true)
    } finally { db.close() }
  })
})
