import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { IngressStore, packageDigest } from '@/service/ingress/store.js'
import { migrateIngressV1 } from '@/service/ingress/migrate.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function legacy() {
  const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'migration-'))
  roots.push(root)
  const store = new IngressStore(root)
  store.initialize()
  const directory = store.directory('packages/legacy/1.0.0')
  fs.writeFileSync(
    path.join(directory, 'index.mjs'),
    'export function createPlugin() { throw new Error("must not run"); }',
  )
  fs.writeFileSync(
    path.join(directory, 'ingress-plugin.json'),
    JSON.stringify({ id: 'legacy', version: '1.0.0', apiVersion: 1, entry: 'index.mjs' }),
  )
  const registration = {
    id: 'legacy',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'index.mjs',
    enabled: true,
    packageDigest: packageDigest(directory),
  }
  store.atomicJson('registry.json', { schemaVersion: 1, revision: 7, plugins: [registration] })
  store.atomicJson('config/legacy.json', {
    schemaVersion: 1,
    revision: 3,
    config: { value: 'keep' },
  })
  store.directory('data/legacy')
  fs.writeFileSync(store.safe('data/legacy/queue.json'), '["pending"]')
  return { store, directory, registration }
}
it('explicit migration is offline, backed up, disabled without grants and repeatable, preserving config/data', () => {
  const { store } = legacy()
  migrateIngressV1(store)
  const registry = store.readRegistry()
  expect(registry).toMatchObject({
    revision: 8,
    plugins: [{ apiVersion: 2, enabled: false, grantedCapabilities: [], channelGrants: [] }],
  })
  expect(store.verify(registry.plugins[0]!)).toContain('/legacy/1.0.0')
  expect(store.readConfig('legacy')).toMatchObject({ revision: 3, config: { value: 'keep' } })
  expect(fs.readFileSync(store.safe('data/legacy/queue.json'), 'utf8')).toBe('["pending"]')
  const marker = store.readJson('migration-api2.json') as { backup: string }
  expect(fs.existsSync(store.safe(`${marker.backup}/registry.json`))).toBe(true)
  migrateIngressV1(store)
  expect(store.readRegistry()).toEqual(registry)
})
it('migration validates all packages and restores the old registry on failure', () => {
  const { store, directory, registration } = legacy()
  const before = store.readJson('registry.json')
  store.atomicJson('registry.json', {
    schemaVersion: 1,
    revision: 7,
    plugins: [registration, { ...registration, id: 'missing' }],
  })
  const invalid = store.readJson('registry.json')
  expect(() => migrateIngressV1(store)).toThrow()
  expect(store.readJson('registry.json')).toEqual(invalid)
  expect(fs.existsSync(path.join(directory, 'config.yaml'))).toBe(false)
  expect(fs.existsSync(store.safe('migration-api2.json'))).toBe(false)
  store.atomicJson('registry.json', before)
  migrateIngressV1(store)
  expect(store.readRegistry().plugins).toHaveLength(1)
})
