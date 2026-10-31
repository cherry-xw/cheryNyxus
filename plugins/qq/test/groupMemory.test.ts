import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { it, expect, vi } from 'vitest'
import { QQGroupMemoryStore } from '../src/groupMemory.js'
import { textVersion } from '../src/files.js'

it('keeps the 160-character limit and preserves saved facts when a 171-character candidate is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qq-facts-limit-'))
  try {
    const consolidate = vi.fn(), store = new QQGroupMemoryStore(root, { maxEntries: 80, maxChars: 160, contextChars: 6000 }, consolidate)
    const subject = { selfId: '123', groupId: '789', conversationType: 'group' as const }
    const source = { source: { recordId: 'rec-1', revision: 1 }, partIds: ['p0'], messageId: '1', senderId: '456', occurredAt: 100, content: '群约定' }
    const fact = { id: 'agreement', topic: '约定', kind: 'agreement', content: '😀'.repeat(160), members: ['456'], evidence: 'statement',
      sources: [{ source: source.source, partIds: source.partIds, messageId: source.messageId, userId: source.senderId, occurredAt: source.occurredAt }], status: 'active' }
    await store.manage(subject, { expectedRevision: 0, save: [fact] }, [source], undefined, 'saved')
    const file = path.join(root, 'memory/topics', textVersion('789') + '.json'), before = await readFile(file, 'utf8')
    await expect(store.manage(subject, { expectedRevision: 1, save: [{ ...fact, content: '旧'.repeat(171) }] }, [source], undefined, 'rejected')).rejects.toThrow('Fact too long')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await store.operationStatus(subject, 'rejected')).toBeUndefined()
    expect((await store.search(subject, '')).revision).toBe(1)
    expect(consolidate).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('shares sourced group experience across senders, isolates groups and rejects invented sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qq-facts-'))
  try {
    const store = new QQGroupMemoryStore(root)
    const a = { selfId: '123', userId: '456', groupId: '789', conversationType: 'group' as const }
    const source = { source: { recordId: 'rec-1', revision: 1 }, partIds: ['p0'], messageId: '-1', senderId: '456', occurredAt: 100, content: '我处理过网络问题，已经恢复了' }
    await store.manage(a, { expectedRevision: 0, save: [{ id: 'network', topic: '网络', kind: 'experience', content: '该成员自述处理过网络故障', members: ['456'], evidence: 'statement', sources: [{ source: { recordId: 'rec-1', revision: 1 }, partIds: ['p0'], messageId: '-1', userId: '456', occurredAt: 100 }], status: 'active' }] }, [source])
    expect((await store.search({ ...a, userId: '111' }, '网络')).records[0]?.members).toEqual(['456'])
    expect((await store.search({ ...a, groupId: '222' }, '网络')).records).toEqual([])
    await expect(store.manage(a, { expectedRevision: 1, save: [{ id: 'fake', topic: '网络', kind: 'experience', content: '伪造', members: ['999'], evidence: 'confirmed_result', sources: [{ source: { recordId: 'rec-1', revision: 1 }, partIds: ['p0'], messageId: '-1', userId: '999', occurredAt: 100 }], status: 'active' }] }, [source])).rejects.toThrow('source')
    await expect(store.manage(a, { expectedRevision: 0, delete: ['network'] }, [])).rejects.toThrow('revision')
    expect((await store.search(a, '')).records).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('ignores legacy member records and starts a clean group store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qq-migration-'))
  try {
    const dir = path.join(root, 'memory/member'); await mkdir(dir, { recursive: true })
    const file = path.join(dir, textVersion('789:456') + '.json')
    const old = JSON.stringify({ memories: { network: '公开经验' }, context: [], identity: { conversationType: 'group', groupId: '789', userId: '456' }, updatedAt: 100 })
    await writeFile(file, old)
    const result = await new QQGroupMemoryStore(root).search({ selfId: '123', userId: '111', groupId: '789', conversationType: 'group' }, '')
    expect(result.records).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(old)
  } finally { await rm(root, { recursive: true, force: true }) }
})
