import { afterEach, beforeEach, expect, test } from 'vitest'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { QQMemoryStore, qqMemoryBatchSchema } from '../src/memory.js'
import { readQQFile, textVersion, writeQQFile } from '../src/files.js'
import { createQQTools, QQ_MEMORY_CONTEXT_KEY } from '../src/tools.js'
import type { QQSubject } from '../src/memory.js'
import type { IngressRequestView } from '@chery/plugin-api'

let root: string
const privateSubject: QQSubject = { selfId: '999', userId: '12345', conversationType: 'private' }
const groupSubject: QQSubject = { ...privateSubject, conversationType: 'group', groupId: '111' }
beforeEach(async () => {
  const scratch = process.env.TMPDIR || '/home/chery/.hermes/profiles/backend/cache/scratch'
  await mkdir(scratch, { recursive: true })
  root = await mkdtemp(path.join(scratch, 'qq-business-'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
test('file results expose trusted personal absolute paths and only share-relative URLs', async () => {
  const result = await writeQQFile(root, privateSubject, { path: 'share/hello world.html', content: 'hello' })
  expect(result.absolutePath).toBe(path.join(root, '12345/share/hello world.html'))
  expect(result.sharePath).toBe('/qq/12345/share/hello%20world.html')
  expect((await readQQFile(root, groupSubject, { path: 'share/hello world.html' })).absolutePath).toBe(result.absolutePath)
  expect(await readFile(result.absolutePath, 'utf8')).toBe('hello')
  const ordinary = await writeQQFile(root, privateSubject, { path: 'private.txt', content: 'private' })
  expect(ordinary.sharePath).toBeNull()
  await expect(readFile(path.join(root, 'private.txt'))).rejects.toThrow()
})

const save = (scope: 'personal' | 'group' | 'member', name: string, content: string) => ({ scope, save: [{ name, content }] })
const memoryFile = (scope: string, key: string) => path.join(root, 'memory', scope, `${textVersion(key)}.json`)

function view(identity: IngressRequestView['identity'], content?: string): IngressRequestView {
  return { requestId: 'request', inputId: 'input', chatId: 'chat', preparedAt: 0,
    configRevision: '1', registryVersion: 1, identity, tools: [], unavailableTools: [],
    contexts: content ? [{ ownerId: 'qq', key: QQ_MEMORY_CONTEXT_KEY, content, configRevision: 1 }] : [] }
}

test('QQ memory isolates personal, group and member scopes without group access to personal data', async () => {
  const store = new QQMemoryStore(root)
  await store.manage(privateSubject, save('personal', 'preference', 'personal-secret'))
  await store.manage(groupSubject, save('group', 'rule', 'group-shared'))
  await store.manage(groupSubject, save('member', 'preference', 'member-secret'))
  const member = await store.prepare(groupSubject)
  expect(member).toContain('group-shared')
  expect(member).toContain('member-secret')
  expect(member).not.toContain('personal-secret')
  const otherMember = await store.prepare({ ...groupSubject, userId: '54321' })
  expect(otherMember).toContain('group-shared')
  expect(otherMember).not.toContain('member-secret')
  const otherGroup = await store.prepare({ ...groupSubject, groupId: '222' })
  expect(otherGroup).not.toContain('group-shared')
  expect(otherGroup).not.toContain('member-secret')
  expect(await store.prepare(privateSubject)).not.toContain('member-secret')
  await expect(store.manage(groupSubject, save('personal', 'x', 'bad'))).rejects.toThrow('范围')
  await expect(store.manage(privateSubject, save('group', 'x', 'bad'))).rejects.toThrow('范围')
  await expect(store.manage(privateSubject, save('member', 'x', 'bad'))).rejects.toThrow('范围')
  await expect(store.prepare({ ...groupSubject, groupId: undefined })).rejects.toThrow()
})

test('strict memory batches reject unknown fields, duplicates, overlap and invalid limits', () => {
  const invalid = [ {}, { scope: 'personal' }, { scope: 'personal', save: [], delete: [] },
    { ...save('personal', 'x', 'ok'), action: 'list' }, save('personal', '../x', 'ok'),
    save('personal', 'x', ' '), save('personal', 'x', 'x'.repeat(301)),
    { scope: 'personal', save: [{ name: 'x', content: 'ok', extra: true }] },
    { scope: 'personal', save: [{ name: 'x', content: 'a' }, { name: 'x', content: 'b' }] },
    { scope: 'personal', delete: ['x', 'x'] }, { ...save('personal', 'x', 'ok'), delete: ['x'] },
    { scope: 'personal', delete: Array.from({ length: 101 }, (_, i) => `x${i}`) },
  ]
  for (const input of invalid) expect(qqMemoryBatchSchema.safeParse(input).success).toBe(false)
  expect(qqMemoryBatchSchema.safeParse(save('personal', 'valid_1-name', 'ok')).success).toBe(true)
})

test('memory writes preserve existing context and identity; corrupt files are never overwritten', async () => {
  const store = new QQMemoryStore(root)
  const target = memoryFile('personal', privateSubject.userId)
  await mkdir(path.dirname(target), { recursive: true })
  const identity = { platform: 'qq', ...privateSubject, nickname: 'sender' }
  await writeFile(target, JSON.stringify({ schemaVersion: 1, revision: 0, memories: { old: 'old value' }, context: ['retained context'], identity, updatedAt: 1 }))
  expect(await store.manage(privateSubject, { ...save('personal', 'new', 'new value'), delete: ['old', 'missing'] })).toEqual({ saved: 1, deleted: 1 })
  const updated = JSON.parse(await readFile(target, 'utf8'))
  expect(updated).toMatchObject({ memories: { new: 'new value' }, context: ['retained context'], identity, schemaVersion: 1, revision: 1 })
  expect(updated.updatedAt).toBeGreaterThan(1)
  const corruptions = ['{broken', JSON.stringify({ ...updated, memories: { bad: 1 } }),
    JSON.stringify({ ...updated, extra: true }), JSON.stringify({ ...updated, identity: { ...identity, userId: '54321' } })]
  for (const corrupt of corruptions) {
    await writeFile(target, corrupt)
    await expect(store.prepare(privateSubject)).rejects.toThrow('损坏')
    await expect(store.manage(privateSubject, save('personal', 'x', 'value'))).rejects.toThrow('损坏')
    expect(await readFile(target, 'utf8')).toBe(corrupt)
  }
})

test('memory batches are atomic, capacity bounded, and concurrent stores retain every fresh write', async () => {
  const store = new QQMemoryStore(root), other = new QQMemoryStore(root)
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? store : other).manage(privateSubject, save('personal', `n${i}`, `value${i}`))))
  const target = memoryFile('personal', privateSubject.userId)
  expect(Object.keys(JSON.parse(await readFile(target, 'utf8')).memories)).toHaveLength(30)
  await store.manage(privateSubject, { scope: 'personal', save: Array.from({ length: 50 }, (_, i) => ({ name: `more${i}`, content: 'value' })) })
  const before = await readFile(target, 'utf8')
  await expect(store.manage(privateSubject, save('personal', 'overflow', 'bad'))).rejects.toThrow('80')
  expect(await readFile(target, 'utf8')).toBe(before)
  await store.manage(privateSubject, { ...save('personal', 'replacement', 'ok'), delete: ['n0'] })
  const snapshot = await store.prepareSnapshot(privateSubject)
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.revisions)).toBe(true)
  await other.manage(privateSubject, save('personal', 'replacement', 'changed'))
  await expect(store.manage(privateSubject, save('personal', 'replacement', 'stale'), undefined, snapshot.revisions.personal)).rejects.toThrow('版本')
  const controller = new AbortController(); controller.abort()
  const unchanged = await readFile(target, 'utf8')
  await expect(store.manage(privateSubject, { scope: 'personal', delete: ['replacement'] }, controller.signal)).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe(unchanged)
})

test('personal files share sender directory across groups/private, isolate senders, and reject stale writers', async () => {
  const first = await writeQQFile(root, groupSubject, { path: 'notes/note.txt', content: '你好\nline2' })
  expect((await readQQFile(root, { ...groupSubject, groupId: '222' }, { path: 'notes/note.txt' })).version).toBe(first.version)
  expect((await readQQFile(root, privateSubject, { path: 'notes/note.txt', offset: 1, limit: 1 })).content).toBe('line2')
  await expect(readQQFile(root, { ...privateSubject, userId: '54321' }, { path: 'notes/note.txt' })).rejects.toThrow()
  await expect(writeQQFile(root, privateSubject, { path: 'notes/note.txt', content: 'bad' })).rejects.toThrow('版本')
  const writes = await Promise.allSettled(['one', 'two'].map(content => writeQQFile(root, privateSubject, { path: 'notes/note.txt', content, expectedVersion: first.version })))
  expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1)
  await expect(writeQQFile(root, privateSubject, { path: 'notes/note.txt', content: 'stale', expectedVersion: first.version })).rejects.toThrow('版本')
  for (const invalid of ['../escape', '/absolute', 'a/./b', 'a//b', 'a\\b', 'a\0b'])
    await expect(writeQQFile(root, privateSubject, { path: invalid, content: 'bad' })).rejects.toThrow('相对')
  await expect(writeQQFile(root, privateSubject, { path: 'big', content: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('1MiB')
  await expect(writeQQFile(root, privateSubject, { path: 'binary', content: '\0' })).rejects.toThrow()
})

test('files and memory reject symlinks at leaf, within root, and above configured root', async () => {
  await mkdir(path.join(root, 'actual'))
  await symlink(path.join(root, 'actual'), path.join(root, 'link'))
  for (const unsafeRoot of [path.join(root, 'link'), path.join(root, 'link', 'child')]) {
    await expect(writeQQFile(unsafeRoot, privateSubject, { path: 'note', content: 'bad' })).rejects.toThrow('符号')
    await expect(new QQMemoryStore(unsafeRoot).manage(privateSubject, save('personal', 'x', 'bad'))).rejects.toThrow('符号')
  }
  await writeQQFile(root, privateSubject, { path: 'note', content: 'ok' })
  await symlink(path.join(root, 'actual'), path.join(root, privateSubject.userId, 'escape'))
  await expect(writeQQFile(root, privateSubject, { path: 'escape/file', content: 'bad' })).rejects.toThrow('符号')
  await symlink(path.join(root, privateSubject.userId, 'note'), path.join(root, privateSubject.userId, 'leaf'))
  await expect(readQQFile(root, privateSubject, { path: 'leaf' })).rejects.toThrow('符号')
  await expect(writeQQFile(root, privateSubject, { path: 'leaf', content: 'bad' })).rejects.toThrow('符号')
})

test('tools require plugin QQ request identity, register scoped memory and file tools, and use request memory revisions', async () => {
  const tools = createQQTools(root, path.join(root, 'files'))
  expect(tools.map(t => t.sense.definition.function.name)).toEqual(['qq_group_memory_search', 'qq_group_memory_manage', 'qq_memory_manage', 'qq_read_file', 'qq_write_file'])
  for (const registration of tools) {
    expect(registration.sense.supervisionLevel).toBe(0)
    expect(registration.sense.definition.function.parameters.additionalProperties).toBe(false)
    const handler = registration.sense.executor.execute
    const input = registration.sense.definition.function.name === 'qq_memory_manage' ? save('personal', 'x', 'ok') : { path: 'note', content: 'ok' }
    for (const identity of [{ source: 'web' as const, channel: 'qq', subject: privateSubject },
      { source: 'plugin' as const, channel: 'web', subject: privateSubject }, { source: 'plugin' as const, channel: 'qq' }]) {
      expect((await handler(input, new Map(), { chatId: 'chat', requestView: view(identity) })).status).toBe('provider_error')
    }
  }
  const store = new QQMemoryStore(root)
  const prepared = await store.prepare(privateSubject)
  const ctx = { chatId: 'chat', requestView: view({ source: 'plugin' as const, channel: 'qq', subject: privateSubject }, prepared) }
  const memoryTool = tools.find(t => t.sense.definition.function.name === 'qq_memory_manage')!.sense.executor.execute
  expect((await memoryTool(save('personal', 'x', 'fresh'), new Map(), ctx)).status).toBe('ok')
  const stale = await memoryTool(save('personal', 'x', 'stale'), new Map(), ctx)
  expect(stale.status).toBe('provider_error')
  expect(stale.content).toContain('版本')
  expect(await store.prepare(privateSubject)).toContain('fresh')
  const fileCtx = { chatId: 'chat', requestView: view({ source: 'plugin', channel: 'qq', subject: privateSubject }) }
  expect((await tools.find(t => t.sense.definition.function.name === 'qq_write_file')!.sense.executor.execute({ path: 'note', content: 'text' }, new Map(), fileCtx)).status).toBe('ok')
  expect((await tools.find(t => t.sense.definition.function.name === 'qq_read_file')!.sense.executor.execute({ path: 'note' }, new Map(), fileCtx)).content).toContain('text')
})
