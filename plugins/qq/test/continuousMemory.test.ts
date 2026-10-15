import { test, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { QQMemoryStore } from '../src/memory.js'
import { textVersion } from '../src/files.js'

test('consolidation validates replacement and retains originals on invalid output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qq-consolidation-'))
  const subject = { selfId: '123', userId: '456', conversationType: 'private' as const }
  const limits = () => ({ maxEntries: 10, maxChars: 160, contextChars: 500, triggerRatio: 0.8, targetRatio: 0.5 })
  let output = '{"merged":"confirmed facts"}'
  let calls = 0
  const store = new QQMemoryStore(root, limits, async () => { calls++; return output })
  try {
    await store.manage(subject, { scope: 'personal', save: Array.from({ length: 8 }, (_, i) => ({ name: `n${i}`, content: 'fact' })) })
    expect(calls).toBe(1)
    const file = path.join(root, 'memory/personal', textVersion('456') + '.json')
    const before = await readFile(file, 'utf8')
    expect(JSON.parse(before).memories).toEqual({ merged: 'confirmed facts' })
    output = '{}'
    await expect(store.manage(subject, { scope: 'personal', save: Array.from({ length: 8 }, (_, i) => ({ name: `x${i}`, content: 'new fact' })) })).rejects.toThrow('为空')
    expect(await readFile(file, 'utf8')).toBe(before)
    await expect(store.manage(subject, { scope: 'personal', save: [{ name: 'long', content: '😀'.repeat(161) }] })).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
