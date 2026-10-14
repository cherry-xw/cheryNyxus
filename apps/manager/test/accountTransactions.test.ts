import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../src/accountStore.js'
import { withConfigTransaction } from '../../backend/src/utils/configTransaction.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nyxus-account-cas-')); roots.push(root)
  const store = new AccountStore(path.join(root, 'account.json'))
  await store.save('admin', 'original-password-long')
  return store
}
describe('F01 Manager password expected hash and text', () => {
  it('allows only one concurrent password change verified against the same original account', async () => {
    const store = await fixture(); const original = (await store.read())!
    const results = await Promise.allSettled([
      store.save('admin', 'first-password-long', true, original),
      new AccountStore(store.file).save('admin', 'second-password-long', true, original),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ message: 'account_changed' }) })])
    const current = (await store.read())!
    expect(current.revision).not.toBe(original.revision)
    expect(await store.verify(current, 'admin', 'first-password-long')).toBe(true)
  })
  it('compares the hash even if a newer writer retained the revision', async () => {
    const store = await fixture(); const original = (await store.read())!
    await store.save('admin', 'newer-password-long', true)
    const changed = (await store.read())!; changed.revision = original.revision
    await fs.writeFile(store.file, JSON.stringify(changed)); const text = await fs.readFile(store.file, 'utf8')
    await expect(store.save('admin', 'stale-password-long', true, original)).rejects.toThrow('account_changed')
    expect(await fs.readFile(store.file, 'utf8')).toBe(text)
  })
  it('rejects a nonparticipating edit during asynchronous password derivation by text CAS', async () => {
    const store = await fixture(); const original = (await store.read())!
    let entered!: () => void; let release!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(store, 'read').mockImplementationOnce(async () => { entered(); await gate; return original })
    const work = store.save('admin', 'attempt-password-long', true, original)
    await ready
    const newer = JSON.stringify({ ...original, username: 'external-newer' })
    await fs.writeFile(store.file, newer)
    release()
    await expect(work).rejects.toThrow('revision conflict')
    expect(await fs.readFile(store.file, 'utf8')).toBe(newer)
  })
  it('rereads the expected account after waiting for another owner', async () => {
    const store = await fixture(); const original = (await store.read())!
    let work: Promise<void> | undefined
    await withConfigTransaction(store.file, async () => {
      work = store.save('admin', 'stale-password-long', true, original)
      await fs.writeFile(store.file, JSON.stringify({ ...original, passwordHash: 'a'.repeat(128) }))
    })
    await expect(work).rejects.toThrow('account_changed')
  })
})
