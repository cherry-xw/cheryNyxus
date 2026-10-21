import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackendIntentStore } from '../src/backendIntent.js'

describe('BackendIntentStore', () => {
  it('keeps stop intent across reopening and independently saves plugin enablement', async () => {
    const root = await mkdtemp('/tmp/opencode/backend-intent-')
    const file = path.join(root, 'intent.json')
    try {
      const store = new BackendIntentStore(file)
      expect(await store.shouldAutoStart(true)).toBe(true)
      const updates = await Promise.all([
        store.save({ desiredState: 'stopped', operationId: 'stop-1' }),
        store.save({ pluginEnabled: false }),
      ])
      expect(updates.map((value) => value.revision)).toEqual([1, 2])
      const reopened = new BackendIntentStore(file)
      expect(await reopened.read()).toMatchObject({ desiredState: 'stopped', pluginEnabled: false, operationId: 'stop-1' })
      expect(await reopened.shouldAutoStart(true)).toBe(false)
      await reopened.save({ desiredState: 'running', pluginEnabled: true, operationId: null })
      expect(await reopened.shouldAutoStart(false)).toBe(false)
      expect(await reopened.shouldAutoStart(true)).toBe(true)
      expect(JSON.parse(await readFile(file, 'utf8')).revision).toBe(3)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not replace corrupt state with an auto-starting default', async () => {
    const root = await mkdtemp('/tmp/opencode/backend-intent-')
    const file = path.join(root, 'intent.json')
    try {
      await writeFile(file, '{broken')
      const store = new BackendIntentStore(file)
      await expect(store.read()).rejects.toThrow()
      await expect(store.save({ desiredState: 'running' })).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe('{broken')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
