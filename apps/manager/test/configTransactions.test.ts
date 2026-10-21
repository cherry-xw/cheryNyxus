import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { OidcConfigStore } from '../src/oidcConfig.js'
import { RelayConfigStore } from '../src/relayConfig.js'
import { BusinessLoginConfigStore } from '../src/businessLoginConfig.js'
import { CredentialStore, writeYaml } from '../src/credentials.js'
import { disableInitialSetup, saveOidcConfig } from '../src/authConfig.js'
import { withConfigTransaction } from '../../backend/src/utils/configTransaction.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const origin = 'https://manager.example'
const oidc = { issuer: 'https://id.example', clientId: 'manager', clientSecret: 'test-secret', redirectUri: `${origin}/api/auth/oidc/callback`, adminSubjects: ['admin'] }
const business = { username: 'business-user', password: 'business-password-long', businessPreset: 'basic' }
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nyxus-manager-tx-')); roots.push(root)
  const file = path.join(root, 'config.yaml')
  await fs.writeFile(file, yaml.dump({ global: { supervision: 'smart' }, llm: { brain: {} }, manager: { auth: { trustedOrigins: [origin] } }, relay: { foreign: 'keep' }, otherEnd: { revision: 7 } }))
  return { root, file }
}
function child(code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    processChild.stderr.on('data', (data) => stderr += data)
    processChild.once('error', reject)
    processChild.once('exit', (exit) => exit === 0 ? resolve() : reject(new Error(stderr)))
  })
}
function moduleUrl(relative: string) { return JSON.stringify(pathToFileURL(path.resolve(relative)).href) }
describe('F01 Manager YAML writer transactions', () => {
  it('serializes all actual Manager YAML writers and preserves unrelated partitions', async () => {
    const { root, file } = await fixture()
    await Promise.all([
      new OidcConfigStore(file).save(oidc, origin),
      saveOidcConfig(file, oidc),
      disableInitialSetup(file),
      new RelayConfigStore(file).save({ backendId: 'device-one', url: 'https://relay.example' }),
      new BusinessLoginConfigStore(file).save(business),
      new CredentialStore({ configFile: file, credentialsFile: path.join(root, 'machine.json') }).rotate({ password: 'machine-password-long' }),
    ])
    const value = yaml.load(await fs.readFile(file, 'utf8')) as Record<string, any>
    expect(value.manager.auth).toMatchObject({ oidc, allowInitialSetup: false, trustedOrigins: [origin] })
    expect(value.server).toMatchObject({ businessPreset: 'basic', auth: { username: 'business-user', machine: { username: 'manager-internal' } } })
    expect(value.relay).toMatchObject({ backendId: 'device-one', foreign: 'keep' })
    expect(value.otherEnd).toEqual({ revision: 7 })
    expect(value.global).toEqual({ supervision: 'smart' })
  })
  it('runs OIDC/relay/Backend-owned writers in independent processes without lost updates', async () => {
    const { file } = await fixture()
    await Promise.all([
      child(`import {OidcConfigStore} from ${moduleUrl('apps/manager/src/oidcConfig.ts')}; await new OidcConfigStore(${JSON.stringify(file)}).save(${JSON.stringify(oidc)},${JSON.stringify(origin)});`),
      child(`import {RelayConfigStore} from ${moduleUrl('apps/manager/src/relayConfig.ts')}; await new RelayConfigStore(${JSON.stringify(file)}).save({backendId:'device-two',url:'https://relay.example'});`),
      child(`import fs from 'node:fs'; import yaml from 'js-yaml'; import {withConfigTransaction,replaceConfigText} from ${moduleUrl('apps/backend/src/utils/configTransaction.ts')}; import {mergeBackendConfig} from ${moduleUrl('apps/backend/src/utils/configOwnership.ts')}; const file=${JSON.stringify(file)}; await withConfigTransaction(file,async()=>{const text=fs.readFileSync(file,'utf8');const value=yaml.load(text);await new Promise(r=>setTimeout(r,50));replaceConfigText(file,yaml.dump(mergeBackendConfig(value,{global:{supervision:'manual'},llm:{brain:{}}})),text)});`),
    ])
    const value = yaml.load(await fs.readFile(file, 'utf8')) as Record<string, any>
    expect(value.manager.auth.oidc).toEqual(oidc)
    expect(value.relay).toMatchObject({ backendId: 'device-two', foreign: 'keep' })
    expect(value.global.supervision).toBe('manual')
    expect(value.otherEnd).toEqual({ revision: 7 })
  })
  it('refuses a nonparticipating concurrent edit through CAS', async () => {
    const { file } = await fixture()
    await expect(withConfigTransaction(file, async () => {
      const current = yaml.load(await fs.readFile(file, 'utf8')) as Record<string, unknown>
      await fs.writeFile(file, 'manager: {newer: true}\n')
      await writeYaml(file, current)
    })).rejects.toThrow('revision conflict')
    expect(await fs.readFile(file, 'utf8')).toBe('manager: {newer: true}\n')
  })
  it.each(['manager: [', '- not-a-mapping', 'false'])('rejects every YAML writer on a bad root without replacement (%s)', async (bad) => {
    const { root, file } = await fixture(); await fs.writeFile(file, bad)
    const writers = [
      () => new OidcConfigStore(file).save(oidc, origin),
      () => saveOidcConfig(file, oidc),
      () => disableInitialSetup(file),
      () => new RelayConfigStore(file).save({ backendId: 'device-one' }),
      () => new BusinessLoginConfigStore(file).save(business),
      () => new CredentialStore({ configFile: file, credentialsFile: path.join(root, 'machine.json') }).rotate({ password: 'machine-password-long' }),
    ]
    for (const write of writers) {
      await expect(write()).rejects.toThrow()
      expect(await fs.readFile(file, 'utf8')).toBe(bad)
    }
  })
})
