import { test, expect } from 'vitest'
import { mkdtemp, rm, symlink, readFile } from 'node:fs/promises'
import path from 'node:path'
import { readQQFile, writeQQFile } from '../../../../plugins/qq/src/files.js'

test('QQ package files share sender across conversations and reject stale writes and symlinks', async () => {
  const root = await mkdtemp(path.join(process.env.CHERY_TEST_RUN_DIR || process.env.TMPDIR!, 'qq-files-'))
  const identity = { selfId: '1', userId: '12345', conversationType: 'group' as const, groupId: '111' }
  try {
    const first = await writeQQFile(root, identity, { path: 'notes/note.txt', content: '你好' })
    expect(await readFile(path.join(root, '12345/notes/note.txt'), 'utf8')).toBe('你好')
    expect((await readQQFile(root, { ...identity, groupId: '222' }, { path: 'notes/note.txt' })).version).toBe(first.version)
    const personal = { selfId: '1', userId: identity.userId, conversationType: 'private' as const }
    expect((await readQQFile(root, personal, { path: 'notes/note.txt' })).content).toBe('你好')
    await expect(writeQQFile(root, personal, { path: 'notes/note.txt', content: 'bad' })).rejects.toThrow('版本')
    await writeQQFile(root, personal, { path: 'notes/note.txt', content: 'updated', expectedVersion: first.version })
    await expect(writeQQFile(root, personal, { path: 'notes/note.txt', content: 'stale', expectedVersion: first.version })).rejects.toThrow('版本')
    await expect(writeQQFile(root, personal, { path: '../bad', content: 'bad' })).rejects.toThrow()
    await symlink(root, path.join(root, '12345/escape'))
    await expect(writeQQFile(root, personal, { path: 'escape/bad', content: 'bad' })).rejects.toThrow('符号')
    await expect(readQQFile(root, { ...personal, userId: '54321' }, { path: 'notes/note.txt' })).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
