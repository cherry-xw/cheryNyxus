import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverStartupConfig } from '../../src/utils/configStartupRecovery.js'
import { withConfigTransaction } from '../../src/utils/configTransaction.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxus-startup-recovery-')); roots.push(root)
  const file = path.join(root, 'config.yaml'); fs.mkdirSync(path.join(root, 'backups'))
  fs.writeFileSync(path.join(root, 'backups/config-20261014-000000.yaml'), yaml.dump({ global: { supervision: 'smart' }, manager: { identity: 'old' }, server: { auth: { password: 'old-hash' } } }))
  const current = { global: { supervision: 'invalid' }, manager: { identity: 'new' }, server: { auth: { password: 'new-hash' } }, relay: { device: 'new' }, otherEnd: { revision: 42 } }
  fs.writeFileSync(file, yaml.dump(current))
  return { root, file, current }
}
describe('F01 guardian recovery ownership', () => {
  it('restores only Backend fields, never stale identities from a full backup', () => {
    const { file, current } = fixture(); const before = fs.readFileSync(file, 'utf8')
    const result = recoverStartupConfig(file)
    expect(result.restored).toBe(true)
    expect(yaml.load(fs.readFileSync(file, 'utf8'))).toEqual({ ...current, global: { supervision: 'smart' } })
    expect(fs.readFileSync(result.rejectedPath, 'utf8')).toBe(before)
  })
  it.each(['manager: [', '- array', 'false'])('preserves malformed/nonmapping candidates exactly (%s)', (bad) => {
    const { file } = fixture(); fs.writeFileSync(file, bad)
    const result = recoverStartupConfig(file)
    expect(result.restored).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(bad)
    expect(fs.readFileSync(result.rejectedPath, 'utf8')).toBe(bad)
  })
  it('refuses a concurrent owner lock without even creating a rejected snapshot', async () => {
    const { root, file } = fixture(); const before = fs.readFileSync(file, 'utf8')
    await withConfigTransaction(file, async () => { expect(() => recoverStartupConfig(file)).toThrow() })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(path.join(root, 'backups'))).toHaveLength(1)
  })
})
