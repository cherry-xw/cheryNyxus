import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { CredentialStore } from '../src/credentials.js'
import { hashPassword } from '../../backend/src/utils/password.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'manager-credentials-'))
  roots.push(root)
  const options = { credentialsFile: join(root, 'credentials.json'), configFile: join(root, 'config.yaml') }
  const keyFile = `${options.credentialsFile}.key`
  return { root, options, keyFile, store: new CredentialStore(options) }
}

function encryptLegacy(password: string, secret: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
  const ciphertext = Buffer.concat([cipher.update(password), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

async function legacy(options: { credentialsFile: string; configFile: string }, secret = options.credentialsFile) {
  const stored = { version: 1, username: 'synthetic-internal', passwordHash: hashPassword('synthetic-password'),
    passwordCipher: encryptLegacy('synthetic-password', secret), updatedAt: '2025-01-01T00:00:00.000Z', password: 'discarded-plaintext' }
  const config = yaml.dump({ server: { auth: { username: stored.username, password: stored.passwordHash, enabled: true } }, unrelated: { keep: true } })
  await writeFile(options.credentialsFile, JSON.stringify(stored), { mode: 0o600 })
  await writeFile(options.configFile, config)
  return { stored, config }
}

function unpack(ciphertext: string, key: Buffer) {
  const packed = Buffer.from(ciphertext, 'base64url')
  const cipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12))
  cipher.setAuthTag(packed.subarray(12, 28))
  return Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString()
}

describe('independent persistent internal credential key', () => {
  it('default constructors share a random 0600 key, not the credentials path', async () => {
    const { store, options, keyFile } = await fixture()
    await store.ensureInternal()
    const key = await readFile(keyFile)
    const stored = JSON.parse(await readFile(options.credentialsFile, 'utf8'))
    expect(key.length).toBe(32)
    expect(stored.version).toBe(2)
    expect(key.equals(createHash('sha256').update(options.credentialsFile).digest())).toBe(false)
    expect(() => unpack(stored.passwordCipher, createHash('sha256').update(options.credentialsFile).digest())).toThrow()
    const second = new CredentialStore(options)
    const auth = await second.auth()
    expect(auth).toMatchObject({ username: 'manager-internal', consistent: true })
    expect(unpack(stored.passwordCipher, key)).toBe(auth.password)
    await second.rotate({ password: 'synthetic-next' })
    expect(await readFile(keyFile)).toEqual(key)
    expect((await store.auth()).password).toBe('synthetic-next')
    if (process.platform !== 'win32') {
      expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
      expect((await stat(options.credentialsFile)).mode & 0o777).toBe(0o600)
    }
  })

  for (const override of [undefined, 'synthetic-legacy-override']) {
    it(`migrates authenticated v1 (${override ? 'explicit key' : 'path key'}) without changing service config`, async () => {
      const { options, keyFile } = await fixture()
      const { stored, config } = await legacy(options, override)
      const store = new CredentialStore({ ...options, encryptionKey: override })
      expect((await store.auth()).password).toBe('synthetic-password')
      const migrated = JSON.parse(await readFile(options.credentialsFile, 'utf8'))
      expect(migrated).toMatchObject({ version: 2, username: stored.username, passwordHash: stored.passwordHash, updatedAt: stored.updatedAt })
      expect(migrated).not.toHaveProperty('password')
      expect(migrated.passwordCipher).not.toBe(stored.passwordCipher)
      expect(await readFile(options.configFile, 'utf8')).toBe(config)
      expect(unpack(migrated.passwordCipher, await readFile(keyFile))).toBe('synthetic-password')
      expect((await new CredentialStore(options).auth()).consistent).toBe(true)
    })
  }

  it('serializes concurrent default provisioning across instances', async () => {
    const { options, keyFile } = await fixture()
    const stores = Array.from({ length: 8 }, () => new CredentialStore(options))
    await Promise.all(stores.map((store) => store.ensureInternal()))
    const auth = await Promise.all(stores.map((store) => store.auth()))
    expect(new Set(auth.map((entry) => entry.password)).size).toBe(1)
    expect(auth.every((entry) => entry.consistent)).toBe(true)
    expect((await readFile(keyFile)).length).toBe(32)
  })

  it('does not let concurrent migration overwrite a rotation', async () => {
    const { options } = await fixture()
    await legacy(options)
    const stores = Array.from({ length: 6 }, () => new CredentialStore(options))
    await Promise.all([...stores.map((store) => store.view()), new CredentialStore(options).rotate({ password: 'synthetic-rotated' })])
    expect(await new CredentialStore(options).auth()).toMatchObject({ password: 'synthetic-rotated', consistent: true })
  })

  for (const damage of ['missing', 'short', 'wrong', 'permissions', 'symlink'] as const) {
    it(`fails closed for ${damage} v2 key without altering ciphertext or config`, async () => {
      if (process.platform === 'win32' && (damage === 'permissions' || damage === 'symlink')) return
      const { store, options, keyFile, root } = await fixture()
      await store.rotate({ password: 'synthetic-password' })
      const before = await readFile(options.credentialsFile, 'utf8')
      const config = await readFile(options.configFile, 'utf8')
      if (damage === 'missing') await rm(keyFile)
      if (damage === 'short') await writeFile(keyFile, 'short')
      if (damage === 'wrong') await writeFile(keyFile, randomBytes(32))
      if (damage === 'permissions') await chmod(keyFile, 0o644)
      if (damage === 'symlink') {
        const target = join(root, 'key-target')
        await writeFile(target, await readFile(keyFile), { mode: 0o600 })
        await rm(keyFile)
        await symlink(target, keyFile)
      }
      await expect(store.auth()).rejects.toThrow()
      await expect(store.ensureInternal()).rejects.toThrow()
      await expect(store.rotate({ password: 'must-not-replace' })).rejects.toThrow()
      expect(await readFile(options.credentialsFile, 'utf8')).toBe(before)
      expect(await readFile(options.configFile, 'utf8')).toBe(config)
      if (damage === 'missing') await expect(stat(keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  for (const damage of ['cipher', 'hash', 'json', 'version'] as const) {
    it(`preserves invalid legacy ${damage} and never provisions a replacement`, async () => {
      const { store, options, keyFile } = await fixture()
      const { stored } = await legacy(options)
      if (damage === 'cipher') stored.passwordCipher = 'invalid-cipher'
      if (damage === 'hash') stored.passwordHash = hashPassword('different-synthetic-password')
      if (damage === 'version') stored.version = 99
      const contents = damage === 'json' ? '{invalid' : JSON.stringify(stored)
      await writeFile(options.credentialsFile, contents)
      const config = await readFile(options.configFile, 'utf8')
      await expect(store.auth()).rejects.toThrow()
      await expect(store.ensureInternal()).rejects.toThrow()
      await expect(store.rotate({})).rejects.toThrow()
      expect(await readFile(options.credentialsFile, 'utf8')).toBe(contents)
      expect(await readFile(options.configFile, 'utf8')).toBe(config)
      await expect(stat(keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  it('does not overwrite a malformed backend configuration', async () => {
    const { store, options, keyFile } = await fixture()
    await writeFile(options.configFile, 'server: [broken')
    await expect(store.ensureInternal()).rejects.toThrow()
    expect(await readFile(options.configFile, 'utf8')).toBe('server: [broken')
    await expect(stat(options.credentialsFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
