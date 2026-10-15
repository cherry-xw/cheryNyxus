import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeBackendConfig, persistStartupPasswordHash } from '../../src/utils/configOwnership.js'
import { hashPassword, verifyPassword } from '../../src/utils/password.js'
import { replaceConfigText, withConfigTransaction, withConfigTransactionSync } from '../../src/utils/configTransaction.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxus-ownership-')); roots.push(root)
  const file = path.join(root, 'config.yaml')
  const value = { global: { supervision: 'smart' }, llm: { brain: {} }, server: { auth: { password: 'original-password', machine: { password: 'machine-hash' } } }, manager: { account: 'new-manager' }, relay: { backendId: 'new-device' }, otherEnd: { revision: 9 } }
  fs.writeFileSync(file, yaml.dump(value))
  return { file, value }
}
describe('F01 owner boundaries and startup password CAS', () => {
  it('replaces/deletes only owned business fields and ignores attempted foreign writes', () => {
    const { value } = fixture()
    const merged = mergeBackendConfig({ ...value, roles: { old: {} } }, { global: { supervision: 'auto' }, manager: { account: 'stale' }, server: {} })
    expect(merged).toEqual({ global: { supervision: 'auto' }, server: value.server, manager: value.manager, relay: value.relay, otherEnd: value.otherEnd })
  })
  it('hashes the exact startup password while preserving all other fields', () => {
    const { file, value } = fixture(); const hash = hashPassword('original-password')
    persistStartupPasswordHash(file, 'original-password', hash)
    expect(yaml.load(fs.readFileSync(file, 'utf8'))).toEqual({ ...value, server: { auth: { ...value.server.auth, password: hash } } })
    expect(verifyPassword('original-password', hash)).toBe(true)
  })
  it.each(['rotated-password', undefined])('refuses a changed/deleted password without writing (%s)', (password) => {
    const { file, value } = fixture()
    fs.writeFileSync(file, yaml.dump({ ...value, server: { auth: { password } } }))
    const before = fs.readFileSync(file, 'utf8')
    expect(() => persistStartupPasswordHash(file, 'original-password', hashPassword('original-password'))).toThrow('changed on disk')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
  it('refuses invalid YAML and a foreign async lock without modifying disk', async () => {
    const { file } = fixture()
    fs.writeFileSync(file, 'server: [')
    const before = fs.readFileSync(file, 'utf8')
    expect(() => persistStartupPasswordHash(file, 'original', 'hash')).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    await withConfigTransaction(file, async () => {
      expect(() => withConfigTransactionSync(file, () => replaceConfigText(file, '{}', before))).toThrow()
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(() => replaceConfigText(file, '{}', before)).toThrow('requires shared transaction')
  })
})
