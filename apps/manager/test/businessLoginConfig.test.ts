import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import yaml from 'js-yaml'
import { BusinessLoginConfigStore } from '../src/businessLoginConfig.js'
describe('independent business login configuration', () => {
  it('saves and reads sanitized business settings without modifying machine or unrelated configuration', async () => {
    const root = '/home/chery/.hermes/cache/scratch/login-development/business-config-tests/' + randomBytes(12).toString('hex')
    await mkdir(root, { recursive: true }); const file = root + '/config.yaml'
    const machine = { username: 'machine', password: 'existing-machine-hash' }
    await writeFile(file, yaml.dump({ server: { auth: { machine } }, presets: { keep: { leader: 'role' } } }))
    const store = new BusinessLoginConfigStore(file)
    const result = await store.save({ username: 'business', password: 'synthetic-password-123', businessPreset: 'basic', browserOrigin: 'https://workbench.example', browserBasePath: '/nyxus' })
    expect(result.passwordConfigured).toBe(true); expect(result).not.toHaveProperty('password'); expect(result.businessPreset).toBe('basic')
    const config = yaml.load(await readFile(file, 'utf8')) as any
    expect(config.server.auth.machine).toEqual(machine); expect(config.presets.keep.leader).toBe('role'); expect(config.server.auth.password).toMatch(/^scrypt\$/)
    await expect(store.save({ username: 'business', businessPreset: 'full', browserOrigin: 'https://workbench.example', browserBasePath: '/../evil' })).rejects.toThrow()
    expect((await store.view()).businessPreset).toBe('basic')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const trust = { username: 'business', businessPreset: 'basic', remoteEnabled: true, proofIssuer: 'https://relay.example/issuer', proofBackendId: 'home-device', proofKeys: { ['k'.repeat(32)]: publicKey.export({ format: 'pem', type: 'spki' }).toString() } }
    const view = await store.save(trust)
    expect(view).toMatchObject({ remoteEnabled: true, proofIssuer: trust.proofIssuer, proofBackendId: trust.proofBackendId, proofKeys: trust.proofKeys })
    expect((yaml.load(await readFile(file, 'utf8')) as any).server.auth.userProof.authorizations).toEqual([])
    const before = await readFile(file, 'utf8')
    await expect(store.save({ ...trust, proofKeys: { ['k'.repeat(32)]: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() } })).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(before)
  })
})
