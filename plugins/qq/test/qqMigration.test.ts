import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { migrateQQ } from '../src/migrate.js'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq.js'
import { emptyState } from '../src/state.js'
const roots: string[] = []
function temp() { const dir = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR || process.env.TMPDIR!, 'qq-migration-')); roots.push(dir); return dir }
function json(file: string, data: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)) }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const configPath = 'config/cherynyxus-qq-module.json'
const statePath = 'data/cherynyxus-qq-module/state.json'
function legacy() { const source = temp(); json(path.join(source, 'bridge.json'), { botId: '1', groups: ['2'], users: ['3'], preset: 'p' }); return source }
test('migration preserves memory context, credential references and external files; repeat does not overwrite new writes', () => {
  const source = legacy(), root = temp(), memory = temp(), files = temp()
  const name = createHash('sha256').update('3').digest('hex') + '.json'
  const data = { memories: { pref: 'value' }, context: ['retained'], identity: { platform: 'qq', conversationType: 'private', userId: '3', nickname: 'user' }, updatedAt: 10 }
  json(path.join(memory, 'qq-personal-memory', name), data)
  fs.mkdirSync(path.join(files, '3')); fs.writeFileSync(path.join(files, '3/note.txt'), 'personal file')
  expect(migrateQQ(source, root, '1', undefined, { memoryRoot: memory, userFilesRoot: files, credentialReferences: ['CHANNEL_TOKEN'] }).completed).toBe(true)
  const target = path.join(root, 'data/cherynyxus-qq-module/memory/personal', name)
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({ ...data, schemaVersion: 1, revision: 0 })
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'data/cherynyxus-qq-module/migration.json'), 'utf8'))
  expect(fs.readFileSync(path.join(marker.backup, 'user-files/3/note.txt'), 'utf8')).toBe('personal file')
  expect(fs.readFileSync(path.join(files, '3/note.txt'), 'utf8')).toBe('personal file')
  expect(JSON.parse(fs.readFileSync(path.join(marker.backup, 'credential-references.json'), 'utf8'))).toEqual(['CHANNEL_TOKEN'])
  fs.writeFileSync(target, 'newer')
  expect(migrateQQ(source, root, '1').alreadyCompleted).toBe(true)
  expect(fs.readFileSync(target, 'utf8')).toBe('newer')
})
test('publication failure restores all untouched candidates; newer writes stop rollback before any mutation', () => {
  const source = legacy(), root = temp()
  expect(() => migrateQQ(source, root, '1', stage => { if (stage === 'state_published') throw new Error('fault') })).toThrow('fault')
  expect(fs.existsSync(path.join(root, statePath))).toBe(false)
  expect(fs.existsSync(path.join(root, configPath))).toBe(false)
  expect(() => migrateQQ(source, root, '1', stage => { if (stage === 'state_published') { fs.writeFileSync(path.join(root, statePath), 'newer'); throw new Error('fault') } })).toThrow('Rollback conflict')
  expect(fs.readFileSync(path.join(root, statePath), 'utf8')).toBe('newer')
  expect(() => migrateQQ(source, root, '1')).toThrow('Rollback conflict')
  expect(fs.existsSync(path.join(root, configPath))).toBe(true)
})
test('current API1 copies preserve revision, binding and queue state and do not implicitly grant permissions', () => {
  const source = temp(), root = temp(), state = emptyState()
  state.identityBinding = { selfId: '1', sourceType: 'napcat-action', verifiedAt: 100, sourceVersion: '1.0.0' }
  json(path.join(source, configPath), { schemaVersion: 1, revision: 7, config: { ...QQDefaultConfig, selfId: '1' } })
  json(path.join(source, statePath), state)
  json(path.join(source, 'registry.json'), { old: 'saved reference' })
  migrateQQ(source, root, '1')
  expect(JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8')).revision).toBe(7)
  expect(JSON.parse(fs.readFileSync(path.join(root, statePath), 'utf8')).identityBinding).toEqual(state.identityBinding)
  expect(fs.existsSync(path.join(root, 'registry.json'))).toBe(false)
})
test('corrupt memory and symlink backups reject before any publication', () => {
  const source = legacy(), root = temp(), memory = temp(), files = temp()
  const dir = path.join(memory, 'qq-personal-memory'); fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a'.repeat(64) + '.json'), '{bad')
  expect(() => migrateQQ(source, root, '1', undefined, { memoryRoot: memory })).toThrow()
  expect(fs.existsSync(path.join(root, configPath))).toBe(false)
  fs.symlinkSync(source, path.join(files, 'escape'))
  expect(() => migrateQQ(source, root, '1', undefined, { userFilesRoot: files })).toThrow('Symlink')
  expect(fs.existsSync(path.join(root, statePath))).toBe(false)
})
test('explicit in-place upgrade restores failures and retains later writes on repeat', () => {
  const root = temp(), state = emptyState()
  const config = { schemaVersion: 1, revision: 7, config: { ...QQDefaultConfig, selfId: '1' } }
  json(path.join(root, configPath), config)
  json(path.join(root, statePath), state)
  json(path.join(root, 'registry.json'), { unrelated: 'retained' })
  const original = fs.readFileSync(path.join(root, configPath), 'utf8')
  expect(() => migrateQQ(root, root, '1')).toThrow('separate')
  expect(() => migrateQQ(root, root, '1', stage => {
    if (stage === 'state_published') throw new Error('fault')
  }, { inPlace: true })).toThrow('fault')
  expect(fs.readFileSync(path.join(root, configPath), 'utf8')).toBe(original)
  expect(JSON.parse(fs.readFileSync(path.join(root, statePath), 'utf8'))).toEqual(state)
  expect(migrateQQ(root, root, '1', undefined, { inPlace: true }).completed).toBe(true)
  json(path.join(root, configPath), { ...config, revision: 8 })
  expect(migrateQQ(root, root, '1', undefined, { inPlace: true }).alreadyCompleted).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8')).revision).toBe(8)
  expect(JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'))).toEqual({ unrelated: 'retained' })
})
